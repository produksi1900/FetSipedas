import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY, EMAIL_DOMAIN } from "./config.js";
import { SPH_CONFIG, DAFTAR_KAB_BABEL } from "./sph-config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// State global
// ============================================================
const state = {
  profile: null,       // {id, username, role, kab_id, nama_tampil}
  tabAktif: null,       // key tab rekon yang sedang dipilih
  chartUtama: null,     // instance Chart.js (di-destroy tiap render ulang)
};

const TAHUN_AWAL = 2018;
const TAHUN_SEKARANG = new Date().getFullYear();

// ============================================================
// Util kecil
// ============================================================
const $ = (id) => document.getElementById(id);

function isiPilihanTahun(select, { withPilihSemua = false } = {}) {
  select.innerHTML = "";
  if (withPilihSemua) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "— pilih —";
    select.appendChild(opt);
  }
  for (let y = TAHUN_SEKARANG; y >= TAHUN_AWAL; y--) {
    const opt = document.createElement("option");
    opt.value = String(y); opt.textContent = String(y);
    select.appendChild(opt);
  }
}

function iqrBounds(values) {
  const arr = values.filter((v) => v && !Number.isNaN(v) && v !== 0).sort((a, b) => a - b);
  if (arr.length < 4) return [null, null];
  const q = (p) => {
    const idx = (arr.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
  };
  const q1 = q(0.25), q3 = q(0.75);
  const iqr = q3 - q1;
  return [q1 - 1.5 * iqr, q3 + 1.5 * iqr];
}
function isOutlier(v, lo, hi) {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0) return false;
  if (lo === null) return false;
  return v < lo || v > hi;
}
function fmt(v, desimal = 2) {
  if (v === null || v === undefined || v === 0) return "-";
  return v.toLocaleString("id-ID", { minimumFractionDigits: desimal, maximumFractionDigits: desimal });
}

// ============================================================
// AUTH — login didok di panel kiri (bukan fullscreen)
// ============================================================
function setLampuKoneksi(aktif) {
  $("lampu-koneksi").classList.toggle("aktif", aktif);
}

function bukaKunci(aktif) {
  // Buka/kunci Section 2 (download) & Section 3 (rekon)
  $("panel-download").classList.toggle("terbuka", aktif);
  $("panel-rekon").classList.toggle("terbuka", aktif);
}

async function cekSesiAwal() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await masukKeApp();
  } else {
    setLampuKoneksi(false);
  }
}

async function masukKeApp() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { return; }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, username, role, kab_id, nama_tampil")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    $("login-error").textContent = "Akun ditemukan tapi profil belum terdaftar. Hubungi admin.";
    await supabase.auth.signOut();
    setLampuKoneksi(false);
    return;
  }

  state.profile = profile;

  // ---- Update UI: header ----
  const labelUser = `${profile.nama_tampil} (${profile.role === "prov" ? "Provinsi" : "Kab/Kota"})`;
  $("lbl-user").textContent = labelUser;
  $("lbl-user").classList.remove("hidden");
  $("lbl-user-inline").textContent = labelUser;
  $("btn-logout").classList.remove("hidden");
  $("info-terakhir").classList.remove("hidden");

  // ---- Update UI: Section 1 ----
  $("blok-login").classList.add("hidden");
  $("blok-connected").classList.remove("hidden");
  $("status-koneksi").textContent = "";
  setLampuKoneksi(true);

  // ---- Buka kunci Section 2 & 3 ----
  bukaKunci(true);

  // ---- Section 2: Download Data ----
  // Sama untuk semua role, cuma beda kuncian Kabupaten:
  // - prov  : boleh pilih kabupaten manapun / "Semua Kabupaten/Kota"
  // - kabkot: terkunci ke kabupatennya sendiri (RLS di Supabase juga
  //           membatasi ini, jadi ini cuma penyesuaian tampilan)
  isiPilihanTahun($("sel-tahun-download"));
  if (profile.role === "prov") {
    $("wrap-kab-download").classList.remove("hidden");
    $("sel-kab-download").innerHTML =
      `<option value="semua">— Semua Kabupaten/Kota —</option>` +
      DAFTAR_KAB_BABEL.map((k) => `<option value="${k.id}">${k.id} - ${k.nama}</option>`).join("");
  } else {
    $("wrap-kab-download").classList.add("hidden");
  }
  $("btn-download").disabled = false;

  isiPilihanTahun($("sel-tahun-rekon"));

  await siapkanKabSelect();
  await muatUlangJenis();
}

function keluarDariApp() {
  state.profile = null;
  $("lbl-user").classList.add("hidden");
  $("btn-logout").classList.add("hidden");
  $("info-terakhir").classList.add("hidden");

  $("blok-login").classList.remove("hidden");
  $("blok-connected").classList.add("hidden");
  setLampuKoneksi(false);
  bukaKunci(false);

  $("btn-download").disabled = true;
  $("wrap-kab-download").classList.add("hidden");

  $("in-username").value = "";
  $("in-password").value = "";
}

$("btn-login").addEventListener("click", login);
$("in-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

$("chk-show-pass").addEventListener("change", (e) => {
  $("in-password").type = e.target.checked ? "text" : "password";
});

async function login() {
  const username = $("in-username").value.trim().toLowerCase();
  const password = $("in-password").value;
  $("login-error").textContent = "";
  $("status-koneksi").textContent = "";

  if (!username || !password) {
    $("login-error").textContent = "Username & password wajib diisi.";
    return;
  }

  $("btn-login").disabled = true;
  $("btn-login").textContent = "Menyambungkan...";
  $("status-koneksi").textContent = "menyambungkan...";

  const email = username + EMAIL_DOMAIN;
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  $("btn-login").disabled = false;
  $("btn-login").textContent = "Sambungkan";

  if (error) {
    $("login-error").textContent = "Username atau password salah.";
    $("status-koneksi").textContent = "";
    setLampuKoneksi(false);
    return;
  }
  await masukKeApp();
}

$("btn-logout").addEventListener("click", async () => {
  await supabase.auth.signOut();
  keluarDariApp();
});

// ============================================================
// PANEL KIRI: DOWNLOAD DATA (baca dari database, export ke Excel)
// ============================================================
// PENTING: web ini TIDAK konek ke sipedas.pertanian.go.id sama sekali.
// Data yang diambil di sini murni dari tabel Supabase (data_sbs/bst/
// tbf/th), yang diisi lewat aplikasi desktop FetSipedas. Kolom Excel
// hasil download SENGAJA dinamai persis seperti yang dicari
// fitur_rekon.py di desktop (lihat excelCols di sph-config.js), supaya
// file ini bisa langsung dipakai di menu "Pilih File Raw" desktop utk
// membuat Excel rekon dinamis (dengan dropdown & grafik).
$("btn-download").addEventListener("click", downloadData);

async function downloadData() {
  if (!state.profile) return;

  const jenis = $("sel-jenis-download").value;
  const tahun = Number($("sel-tahun-download").value);
  const cfg = SPH_CONFIG[jenis];
  const logBox = $("log-download");
  const btn = $("btn-download");

  // Tentukan kabupaten yang mau diambil.
  // kabId === null artinya "semua kabupaten" (cuma boleh utk role prov;
  // untuk kabkot selalu dikunci ke kab_id miliknya sendiri).
  let kabId = null;
  if (state.profile.role === "kabkot") {
    kabId = state.profile.kab_id;
  } else {
    const pilihan = $("sel-kab-download").value;
    kabId = pilihan === "semua" ? null : pilihan;
  }

  btn.disabled = true;
  btn.textContent = "⏳ Mengambil data...";
  logBox.textContent = `Mengambil data ${jenis.toUpperCase()} tahun ${tahun} dari database...`;

  try {
    let query = supabase.from(cfg.table).select("*").eq("tahun", tahun);
    if (kabId) query = query.eq("kab", kabId);
    const { data: rows, error } = await query.order("urutkec", { ascending: true });

    if (error) throw error;

    if (!rows || rows.length === 0) {
      logBox.textContent =
        `Tidak ada data ${jenis.toUpperCase()} tahun ${tahun}` +
        `${kabId ? "" : " untuk seluruh kabupaten"}.\n` +
        `(Kemungkinan belum ada sinkronisasi dari aplikasi desktop.)`;
      return;
    }

    // Susun baris Excel: kolom umum + kolom indikator dgn nama sesuai
    // excelCols (mengandung kata kunci yang dicari fitur_rekon.py).
    const rowsExcel = rows.map((r) => {
      const out = {
        kab: r.kab,
        nama_kab: r.nama_kab,
        urutkec: r.urutkec,
        kec: r.kec,
        nama_kec: r.nama_kec,
        idtanaman: r.idtanaman,
        namatanaman: r.namatanaman,
        tahun: r.tahun,
        [cfg.periodeCol]: r[cfg.periodeCol],
      };
      for (const [dbCol, headerExcel] of Object.entries(cfg.excelCols)) {
        out[headerExcel] = r[dbCol] ?? 0;
      }
      return out;
    });

    const ws = XLSX.utils.json_to_sheet(rowsExcel);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.label.slice(0, 31));

    const labelKab = kabId
      ? (DAFTAR_KAB_BABEL.find((k) => k.id === kabId)?.nama ?? kabId)
      : "SemuaKab";
    const namaFile = `${cfg.label}_${labelKab.replace(/\s+/g, "")}_${tahun}.xlsx`;
    XLSX.writeFile(wb, namaFile);

    logBox.textContent =
      `✓ Selesai! ${rows.length} baris diexport ke "${namaFile}".\n` +
      `File ini bisa langsung dipakai di aplikasi desktop FetSipedas ` +
      `(menu "3. Rekonsiliasi" → Pilih File Raw) untuk membuat Excel ` +
      `rekon dinamis (dengan dropdown & grafik).`;

    await muatInfoTerakhir();
  } catch (e) {
    logBox.textContent = `✗ Gagal mengambil/export data: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download Data (Excel)";
  }
}

async function muatInfoTerakhir() {
  const jenis = $("sel-jenis").value;
  const { data } = await supabase
    .from("sync_meta")
    .select("tahun, last_synced_at, status")
    .eq("jenis", jenis)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    $("info-terakhir").innerHTML = `Belum ada data ${jenis.toUpperCase()} yang pernah disinkronkan.`;
    return;
  }
  const tgl = new Date(data.last_synced_at);
  const teks = tgl.toLocaleString("id-ID", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta",
  });
  $("info-terakhir").innerHTML =
    `Data <strong>${jenis.toUpperCase()}</strong> (tahun ${data.tahun}) terakhir diperbarui: <strong>${teks} WIB</strong> — status: ${data.status}`;
}

// ============================================================
// PANEL KANAN: REKON
// ============================================================
$("sel-jenis").addEventListener("change", muatUlangJenis);
$("sel-tahun-rekon").addEventListener("change", async () => { await siapkanKabSelect(); await muatData(); });
$("sel-kab").addEventListener("change", async () => { await siapkanKomoditiSelect(); await muatData(); });
$("sel-komoditi").addEventListener("change", muatData);

async function muatUlangJenis() {
  if (!state.profile) return;
  await siapkanTabBar();
  await siapkanKabSelect();
  await muatInfoTerakhir();
}

function siapkanTabBar() {
  const jenis = $("sel-jenis").value;
  const cfg = SPH_CONFIG[jenis];
  const bar = $("tab-bar");
  bar.innerHTML = "";
  cfg.tabs.forEach((tab, i) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (i === 0 ? " aktif" : "");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      state.tabAktif = tab.key;
      Array.from(bar.children).forEach((c) => c.classList.remove("aktif"));
      btn.classList.add("aktif");
      muatData();
    });
    bar.appendChild(btn);
  });
  state.tabAktif = cfg.tabs[0].key;
}

async function siapkanKabSelect() {
  if (!state.profile) return;
  const selKab = $("sel-kab");

  // kabkot: dikunci ke kab_id miliknya sendiri
  if (state.profile.role === "kabkot") {
    const kab = DAFTAR_KAB_BABEL.find((k) => k.id === state.profile.kab_id);
    selKab.innerHTML = `<option value="${state.profile.kab_id}">${kab ? kab.nama : state.profile.kab_id}</option>`;
    selKab.disabled = true;
    return;
  }

  selKab.disabled = false;
  selKab.innerHTML = DAFTAR_KAB_BABEL
    .map((k) => `<option value="${k.id}">${k.id} - ${k.nama}</option>`)
    .join("");
  await siapkanKomoditiSelect();
}

async function siapkanKomoditiSelect() {
  const jenis = $("sel-jenis").value;
  const cfg = SPH_CONFIG[jenis];
  const tahun = Number($("sel-tahun-rekon").value);
  const kabId = $("sel-kab").value;
  const selKom = $("sel-komoditi");

  selKom.innerHTML = `<option value="">Memuat...</option>`;

  const { data, error } = await supabase
    .from(cfg.table)
    .select("namatanaman")
    .eq("tahun", tahun)
    .eq("kab", kabId)
    .limit(5000);

  if (error || !data) {
    selKom.innerHTML = `<option value="">(gagal memuat)</option>`;
    return;
  }
  const unik = Array.from(new Set(data.map((r) => r.namatanaman))).sort();
  selKom.innerHTML = unik.length
    ? unik.map((n) => `<option value="${n}">${n}</option>`).join("")
    : `<option value="">(tidak ada komoditi)</option>`;
}

async function muatData() {
  if (!state.profile) return;
  const jenis = $("sel-jenis").value;
  const cfg = SPH_CONFIG[jenis];
  const tahun = Number($("sel-tahun-rekon").value);
  const kabId = $("sel-kab").value;
  const komoditi = $("sel-komoditi").value;
  const area = $("rekon-area");

  if (!kabId || !komoditi) {
    area.innerHTML = `<div class="placeholder-kosong">Pilih kabupaten & komoditi untuk mulai.</div>`;
    return;
  }

  area.innerHTML = `<div class="placeholder-kosong">⏳ Memuat data...</div>`;

  const { data: rows, error } = await supabase
    .from(cfg.table)
    .select("*")
    .eq("tahun", tahun)
    .eq("kab", kabId)
    .eq("namatanaman", komoditi)
    .order("urutkec", { ascending: true });

  if (error) {
    area.innerHTML = `<div class="placeholder-kosong">Gagal memuat data: ${error.message}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    area.innerHTML = `<div class="placeholder-kosong">Tidak ada data untuk kombinasi ini.</div>`;
    return;
  }

  renderRekon(cfg, rows, komoditi);
}

function renderRekon(cfg, rows, komoditi) {
  const tab = cfg.tabs.find((t) => t.key === state.tabAktif) ?? cfg.tabs[0];
  const periodeCol = cfg.periodeCol;
  const periodeLabels = cfg.periodeLabels; // index 0 = periode 1

  // Kumpulkan daftar kecamatan unik (urut sesuai urutkec)
  const kecMap = new Map(); // kec_id -> {kode, nama, urut}
  for (const r of rows) {
    if (!kecMap.has(r.kec)) kecMap.set(r.kec, { kode: r.kec, nama: r.nama_kec, urut: r.urutkec ?? 0 });
  }
  const kecRows = Array.from(kecMap.values()).sort((a, b) => a.urut - b.urut);

  // Bangun matrix (kec, periode) -> nilai sesuai tab aktif
  function nilaiBaris(r) {
    if (tab.single) return Number(r[tab.single]) || 0;
    const numer = (Number(r[tab.numer]) || 0) * (tab.numerFactor ?? 1);
    const denom = Number(r[tab.denom]) || 0;
    return denom !== 0 ? numer / denom : 0;
  }

  const matrix = new Map(); // `${kec}|${periode}` -> nilai
  for (const r of rows) {
    const per = Number(r[periodeCol]);
    matrix.set(`${r.kec}|${per}`, nilaiBaris(r));
  }

  const semuaNilai = [];
  for (const k of kecRows) {
    for (let p = 1; p <= periodeLabels.length; p++) {
      semuaNilai.push(matrix.get(`${k.kode}|${p}`) ?? 0);
    }
  }
  const [lo, hi] = iqrBounds(semuaNilai);

  const area = $("rekon-area");
  area.innerHTML = "";

  // ---- Tabel ----
  const blok = document.createElement("div");
  blok.className = "tabel-blok";
  blok.innerHTML = `
    <div class="tabel-judul">
      <span>${tab.label} — ${komoditi}</span>
      <span class="satuan">${tab.satuan}</span>
    </div>
  `;
  const table = document.createElement("table");
  table.className = "tabel-rekon";

  const theadCols = ["No", "Kode", "Kecamatan", ...periodeLabels.map((p) => (cfg.periodeCol === "triwulan" ? `Tw${p}` : p)), "Mean"];
  table.innerHTML = `<thead><tr>${theadCols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;

  const tbody = document.createElement("tbody");
  kecRows.forEach((k, i) => {
    const tr = document.createElement("tr");
    let tds = `<td>${i + 1}</td><td>${k.kode}</td><td class="nama">${k.nama}</td>`;
    const nilaiBarisIni = [];
    for (let p = 1; p <= periodeLabels.length; p++) {
      const v = matrix.get(`${k.kode}|${p}`) ?? 0;
      nilaiBarisIni.push(v);
      const outlierCls = isOutlier(v, lo, hi) ? " outlier" : "";
      tds += `<td class="${outlierCls}">${fmt(v, tab.single === "harga_jual_petani" ? 0 : 2)}</td>`;
    }
    const nz = nilaiBarisIni.filter((v) => v !== 0);
    const mean = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0;
    tds += `<td>${fmt(mean, tab.single === "harga_jual_petani" ? 0 : 2)}</td>`;
    tr.innerHTML = tds;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  blok.appendChild(table);
  area.appendChild(blok);

  // ---- Grafik ----
  const chartWrap = document.createElement("div");
  chartWrap.className = "chart-wrap";
  chartWrap.innerHTML = `<h4>Grafik ${tab.label} — ${komoditi}</h4><canvas id="canvas-chart-utama"></canvas>`;
  area.appendChild(chartWrap);

  if (state.chartUtama) state.chartUtama.destroy();
  const ctx = document.getElementById("canvas-chart-utama").getContext("2d");
  const labelsX = periodeLabels.map((p) => (cfg.periodeCol === "triwulan" ? `Tw${p}` : p));
  const palet = ["#1f9d6e", "#c0392b", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#d35400", "#7f8c8d", "#2c3e50", "#f39c12"];

  state.chartUtama = new Chart(ctx, {
    type: "line",
    data: {
      labels: labelsX,
      datasets: kecRows.map((k, i) => ({
        label: k.nama,
        data: periodeLabels.map((_, idx) => matrix.get(`${k.kode}|${idx + 1}`) ?? null),
        borderColor: palet[i % palet.length],
        backgroundColor: palet[i % palet.length],
        spanGaps: true,
        tension: 0,
      })),
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

// ============================================================
// Mulai
// ============================================================
cekSesiAwal();
