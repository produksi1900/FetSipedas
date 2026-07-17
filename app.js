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
  chartInstances: [],   // instance-instance Chart.js aktif (di-destroy tiap render ulang)
  idTanamanUrutan: { sbs: {}, bst: {}, tbf: {}, th: {} }, // jenis -> {namatanaman_lower: urutan}
};

const TAHUN_AWAL = 2018;
const TAHUN_SEKARANG = new Date().getFullYear();

// ============================================================
// PENTING — fetchAllRows()
// ============================================================
// Supabase/PostgREST punya batas default jumlah baris per request
// (biasanya 1000), TERLEPAS dari berapapun angka yang ditulis di
// .limit() di sisi client. Kalau baris utk 1 kombinasi tahun+kab (atau
// tahun+komoditi utk "semua kab") lebih banyak dari batas itu (gampang
// kejadian kalau banyak kecamatan x komoditi x periode), maka baris yang
// "kepotong" itu HILANG BEGITU SAJA dari hasil query -- urutan hasil
// juga tidak dijamin, jadi komoditi mana yang kepotong bisa beda-beda
// setiap kali sync ulang dari aplikasi desktop. Ini akar penyebab
// "komoditi ada di database tapi ga muncul di dropdown / tabel Rata-Rata
// / hasil download Excel".
//
// Fix: selalu ambil data lewat helper ini, yang melakukan pagination
// pakai .range() sampai benar-benar habis (bukan cuma 1x request).
//
// queryFn menerima (from, to) dan harus mengembalikan query supabase
// yang SUDAH di .select(...)/.eq(...)/.order(...) dst, tinggal di-range.
const SUPABASE_PAGE_SIZE = 1000;
async function fetchAllRows(queryFn) {
  let semua = [];
  let from = 0;
  while (true) {
    const to = from + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = await queryFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    semua = semua.concat(data);
    if (data.length < SUPABASE_PAGE_SIZE) break; // halaman terakhir
    from += SUPABASE_PAGE_SIZE;
  }
  return semua;
}

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
      DAFTAR_KAB_BABEL.map((k) => `<option value="${k.id}">${k.nama}</option>`).join("");
  } else {
    $("wrap-kab-download").classList.add("hidden");
  }
  $("btn-download").disabled = false;

  isiPilihanTahun($("sel-tahun-rekon"));

  // ---- Section 3: Referensi ID Tanaman (khusus prov) ----
  $("panel-referensi").classList.toggle("hidden", profile.role !== "prov");

  // ---- Penomoran section Rekonsiliasi: geser jadi "3." utk kabkot
  // karena mereka tidak punya section 3 (Referensi ID Tanaman) ----
  $("label-rekon").textContent = profile.role === "prov"
    ? "4. Rekonsiliasi Data"
    : "3. Rekonsiliasi Data";

  await muatReferensiIdTanaman();
  await siapkanKabSelect();
  await muatUlangJenis();
  await muatData(); // render otomatis begitu selesai login, tanpa perlu klik ulang dropdown
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
  $("panel-referensi").classList.add("hidden");
  $("in-file-referensi").value = "";
  $("log-referensi").textContent = "Belum ada file dipilih.";

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
//
// CATATAN FILTER KABUPATEN: kolom "kab" di database berisi kode internal
// dari API sipedas asli (mis. "01", "02", dst — beda dengan kode BPS
// 4 digit). Kode ini TIDAK dipakai untuk filter di web karena rawan
// berubah/tidak konsisten antar kabupaten. Sebagai gantinya, filter di
// web ini pakai kolom "nama_kab" (nama kabupaten apa adanya dari hasil
// sinkronisasi desktop), yang jauh lebih stabil dan mudah dicocokkan.
$("btn-download").addEventListener("click", downloadData);

async function downloadData() {
  if (!state.profile) return;

  const jenis = $("sel-jenis-download").value;
  const tahun = Number($("sel-tahun-download").value);
  const cfg = SPH_CONFIG[jenis];
  const logBox = $("log-download");
  const btn = $("btn-download");

  // Tentukan kabupaten yang mau diambil (berdasarkan nama_kab).
  // kabNama === null artinya "semua kabupaten" (cuma boleh utk role prov;
  // untuk kabkot selalu dikunci ke kabupatennya sendiri lewat kab_id
  // profil -- lihat catatan di siapkanKabSelect()).
  let kabNama = null;
  if (state.profile.role === "kabkot") {
    kabNama = state.profile.kab_id;
  } else {
    const pilihan = $("sel-kab-download").value;
    kabNama = pilihan === "semua" ? null : pilihan;
  }

  btn.disabled = true;
  btn.textContent = "⏳ Mengambil data...";
  logBox.textContent = `Mengambil data ${jenis.toUpperCase()} tahun ${tahun} dari database...`;

  try {
    const rows = await fetchAllRows((from, to) => {
      let query = supabase.from(cfg.table).select("*").eq("tahun", tahun);
      if (kabNama) query = query.eq("nama_kab", kabNama);
      return query
        .order(cfg.periodeCol, { ascending: true })
        .order("kab", { ascending: true })
        .order("urutkec", { ascending: true })
        .order("idtanaman", { ascending: true, nullsFirst: false })
        .range(from, to);
    });

    if (!rows || rows.length === 0) {
      logBox.textContent =
        `Tidak ada data ${jenis.toUpperCase()} tahun ${tahun}` +
        `${kabNama ? "" : " untuk seluruh kabupaten"}.\n` +
        `(Kemungkinan belum ada sinkronisasi dari aplikasi desktop.)`;
      return;
    }

    // Susun baris Excel: kolom umum + kolom indikator dgn nama sesuai
    // excelCols (mengandung kata kunci yang dicari fitur_rekon.py).
    const rowsExcel = rows.map((r) => {
      const out = {
        idtanaman: r.idtanaman,
        namatanaman: r.namatanaman,
        kab: r.kab,
        nama_kab: r.nama_kab,
        urutkec: r.urutkec,
        kec: r.kec,
        nama_kec: r.nama_kec,
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
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

    const labelKab = kabNama ?? "SemuaKab";
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
  const tahun = Number($("sel-tahun-rekon").value);

  const { data } = await supabase
    .from("sync_meta")
    .select("tahun, last_synced_at, status")
    .eq("jenis", jenis)
    .eq("tahun", tahun)
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    $("info-terakhir").innerHTML =
      `Belum ada data <strong>${jenis.toUpperCase()}</strong> tahun <strong>${tahun}</strong> yang pernah disinkronkan.`;
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
$("sel-tahun-rekon").addEventListener("change", async () => { await muatInfoTerakhir(); await siapkanKabSelect(); await muatData(); });
$("sel-kab").addEventListener("change", async () => { await siapkanKomoditiSelect(); await muatData(); });
$("sel-komoditi").addEventListener("change", muatData);

async function muatUlangJenis() {
  if (!state.profile) return;
  siapkanTabBar();
  await siapkanKabSelect();
  await muatInfoTerakhir();
  await muatData();
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

  // kabkot: dikunci ke kabupatennya sendiri. Langsung pakai kab_id dari
  // profil -- JANGAN tebak dari sample row seperti versi lama (kalau RLS
  // longgar/bug, baris yang ke-ambil bisa kabupaten LAIN, pernah kejadian
  // user Kota Pangkal Pinang malah dapat baris Bangka). kab_id di profil
  // WAJIB persis sama dengan nama_kab di DB / id di DAFTAR_KAB_BABEL.
  if (state.profile.role === "kabkot") {
    const namakabDB = state.profile.kab_id;
    const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === namakabDB);
    const labelKab = kabEntry ? kabEntry.nama : namakabDB;
    selKab.innerHTML = `<option value="${namakabDB}">${labelKab}</option>`;
    selKab.disabled = true;
    await siapkanKomoditiSelect();
    return;
  }

  selKab.disabled = false;
  selKab.innerHTML = DAFTAR_KAB_BABEL
    .map((k) => `<option value="${k.id}">${k.nama}</option>`)
    .join("");
  await siapkanKomoditiSelect();
}

async function siapkanKomoditiSelect() {
  const jenis = $("sel-jenis").value;
  const cfg = SPH_CONFIG[jenis];
  const tahun = Number($("sel-tahun-rekon").value);
  const kabNama = $("sel-kab").value;
  const selKom = $("sel-komoditi");

  selKom.innerHTML = `<option value="">Memuat...</option>`;

  let data;
  try {
    data = await fetchAllRows((from, to) =>
      supabase
        .from(cfg.table)
        .select("namatanaman")
        .eq("tahun", tahun)
        .eq("nama_kab", kabNama)
        .range(from, to)
    );
  } catch (e) {
    selKom.innerHTML = `<option value="">(gagal memuat)</option>`;
    return;
  }
  const unik = Array.from(new Set(data.map((r) => r.namatanaman)));

  // Urutkan sesuai referensi id_tanaman (Section 3, diupload role prov),
  // persis seperti urutan_referensi di fitur_sbs.py (desktop). Komoditi
  // yang belum ada di referensi ditaruh di paling akhir, alfabetis.
  const urutanMap = state.idTanamanUrutan[jenis] || {};
  unik.sort((a, b) => {
    const ua = urutanMap[normalisasiNamaTanaman(a)];
    const ub = urutanMap[normalisasiNamaTanaman(b)];
    if (ua !== undefined && ub !== undefined) return ua - ub;
    if (ua !== undefined) return -1;
    if (ub !== undefined) return 1;
    return a.localeCompare(b, "id");
  });

  selKom.innerHTML = unik.length
    ? unik.map((n) => `<option value="${n}">${n}</option>`).join("")
    : `<option value="">(tidak ada komoditi)</option>`;
}

function normalisasiNamaTanaman(n) {
  return String(n ?? "").trim().toLowerCase();
}

// ============================================================
// SECTION 3: REFERENSI ID TANAMAN (khusus role "prov")
// ============================================================
// Urutan baris di file Excel yang diupload -> kolom "urutan" di tabel
// id_tanaman -> dipakai buat sort dropdown Komoditi di panel Rekon.
async function muatReferensiIdTanaman() {
  let data = [];
  try {
    data = await fetchAllRows((from, to) =>
      supabase.from("id_tanaman").select("jenis, namatanaman, urutan").range(from, to)
    );
  } catch (e) {
    data = [];
  }
  const map = { sbs: {}, bst: {}, tbf: {}, th: {} };
  if (data) {
    for (const row of data) {
      if (!map[row.jenis]) map[row.jenis] = {};
      map[row.jenis][normalisasiNamaTanaman(row.namatanaman)] = row.urutan;
    }
  }
  state.idTanamanUrutan = map;
}

const btnUploadReferensi = $("btn-upload-referensi");
if (btnUploadReferensi) btnUploadReferensi.addEventListener("click", uploadReferensiIdTanaman);

async function uploadReferensiIdTanaman() {
  const fileInput = $("in-file-referensi");
  const logBox = $("log-referensi");
  const btn = $("btn-upload-referensi");
  const file = fileInput.files[0];

  if (!file) {
    logBox.textContent = "Pilih file Excel referensi dulu.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "⏳ Memproses...";
  logBox.textContent = "Membaca file...";

  const jenisValid = ["sbs", "bst", "tbf", "th"];

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const hasil = [];

    for (const sheetName of wb.SheetNames) {
      const jenis = sheetName.trim().toLowerCase();
      if (!jenisValid.includes(jenis)) continue;

      const rowsSheet = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
      const daftar = [];
      let urutan = 0;
      for (const row of rowsSheet) {
        const nama = String(row.namatanaman ?? row.Namatanaman ?? row.NamaTanaman ?? "").trim();
        if (!nama) continue;
        urutan += 1;
        const idRaw = row.idtanaman ?? row.Idtanaman ?? row.IdTanaman ?? "";
        daftar.push({
          jenis,
          namatanaman: nama,
          idtanaman: idRaw === "" ? null : String(idRaw),
          urutan,
        });
      }
      if (daftar.length === 0) continue;

      logBox.textContent = `Mengupload ${daftar.length} komoditi untuk jenis ${jenis.toUpperCase()}...`;

      // Ganti semua referensi lama utk jenis ini (delete lalu insert ulang).
      const { error: errDel } = await supabase.from("id_tanaman").delete().eq("jenis", jenis);
      if (errDel) throw new Error(`Gagal hapus referensi lama (${jenis.toUpperCase()}): ${errDel.message}`);

      const { error: errIns } = await supabase.from("id_tanaman").insert(daftar);
      if (errIns) throw new Error(`Gagal upload referensi (${jenis.toUpperCase()}): ${errIns.message}`);

      hasil.push(`${jenis.toUpperCase()}: ${daftar.length} komoditi`);
    }

    if (hasil.length === 0) {
      logBox.textContent =
        "Tidak ada sheet valid ditemukan.\n" +
        "Nama sheet di file Excel harus persis: sbs, bst, tbf, atau th.";
    } else {
      logBox.textContent = `✓ Referensi berhasil diupdate!\n${hasil.join("\n")}`;
      await muatReferensiIdTanaman();
      // Refresh dropdown komoditi yang sedang aktif (kalau ada) supaya
      // urutan barunya langsung kepakai.
      if ($("sel-kab").value) await siapkanKomoditiSelect();
    }
  } catch (e) {
    logBox.textContent = `✗ Gagal: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "⬆ Upload Referensi";
  }
}

async function muatData() {
  if (!state.profile) return;
  const jenis = $("sel-jenis").value;
  const cfg = SPH_CONFIG[jenis];
  const tahun = Number($("sel-tahun-rekon").value);
  const kabNama = $("sel-kab").value;
  const komoditi = $("sel-komoditi").value;
  const area = $("rekon-area");

  if (!kabNama || !komoditi) {
    area.innerHTML = `<div class="placeholder-kosong">Pilih kabupaten & komoditi untuk mulai.</div>`;
    return;
  }

  area.innerHTML = `<div class="placeholder-kosong">⏳ Memuat data...</div>`;

  // Data kabupaten terpilih (utk tabel utama & grafik per kecamatan)
  let rowsKab;
  try {
    rowsKab = await fetchAllRows((from, to) =>
      supabase
        .from(cfg.table)
        .select("*")
        .eq("tahun", tahun)
        .eq("nama_kab", kabNama)
        .eq("namatanaman", komoditi)
        .order("urutkec", { ascending: true })
        .range(from, to)
    );
  } catch (error) {
    area.innerHTML = `<div class="placeholder-kosong">Gagal memuat data: ${error.message}</div>`;
    return;
  }
  if (!rowsKab || rowsKab.length === 0) {
    area.innerHTML = `<div class="placeholder-kosong">Tidak ada data untuk kombinasi ini.</div>`;
    return;
  }

  // Data SEMUA kabupaten (komoditi & tahun sama) utk tabel & grafik
  // "Rata-Rata ... menurut Kabupaten & Bulan/Triwulan" (persis spt desktop).
  // RLS Supabase otomatis membatasi ini kalau role-nya kabkot.
  // PENTING: query ini paling rawan kepotong batas baris karena tidak
  // difilter per kabupaten (gabungan 7 kab x semua kecamatan x semua
  // periode), jadi WAJIB lewat fetchAllRows juga.
  let rowsSemua = [];
  try {
    rowsSemua = await fetchAllRows((from, to) =>
      supabase
        .from(cfg.table)
        .select("*")
        .eq("tahun", tahun)
        .eq("namatanaman", komoditi)
        .range(from, to)
    );
  } catch (e) {
    rowsSemua = [];
  }

  renderRekon(cfg, rowsKab, rowsSemua, komoditi);
}

// ---- Helper umum ----

function nilaiFromRow(r, tab) {
  if (tab.single) return Number(r[tab.single]) || 0;
  // PENTING (fix bug 100x): produksi disimpan Kg, luas/denom lain
  // disimpan satuan aslinya (M2 utk luas, pohon utk BST). numerFactor
  // dipakai supaya hasil provitas dalam Kuintal/Ha (atau Kg/Pohon utk
  // BST) sama seperti aplikasi desktop.
  const numer = (Number(r[tab.numer]) || 0) * (tab.numerFactor ?? 1);
  const denom = Number(r[tab.denom]) || 0;
  return denom !== 0 ? numer / denom : 0;
}

function pivotKec(rows) {
  const kecMap = new Map();
  for (const r of rows) {
    if (!kecMap.has(r.kec)) kecMap.set(r.kec, { kode: r.kec, nama: r.nama_kec, urut: r.urutkec ?? 0 });
  }
  return Array.from(kecMap.values()).sort((a, b) => a.urut - b.urut);
}

// Tabel kecamatan x periode, dgn kolom Mean, highlight outlier
// (IQR method persis spt desktop fitur_rekon.py: _iqr_bounds/_is_outlier,
// nilai 0 diabaikan, minimal 4 nilai valid).
function buatTabelKecPeriode({ judul, satuan, kecRows, matrix, nPeriode, headerLabels, desimal = 2 }) {
  const semuaNilai = [];
  for (const k of kecRows) for (let p = 1; p <= nPeriode; p++) semuaNilai.push(matrix.get(`${k.kode}|${p}`) ?? 0);
  const [lo, hi] = iqrBounds(semuaNilai);

  const blok = document.createElement("div");
  blok.className = "tabel-blok";
  blok.innerHTML = `<div class="tabel-judul"><span>${judul}</span><span class="satuan">${satuan}</span></div>`;

  const table = document.createElement("table");
  table.className = "tabel-rekon";
  const theadCols = ["No", "Kode", "Kecamatan", ...headerLabels, "Mean"];
  table.innerHTML = `<thead><tr>${theadCols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;

  const tbody = document.createElement("tbody");
  kecRows.forEach((k, i) => {
    const tr = document.createElement("tr");
    let tds = `<td>${i + 1}</td><td>${k.kode}</td><td class="nama">${k.nama}</td>`;
    const rowVals = [];
    for (let p = 1; p <= nPeriode; p++) {
      const v = matrix.get(`${k.kode}|${p}`) ?? 0;
      rowVals.push(v);
      const outlierCls = isOutlier(v, lo, hi) ? " outlier" : "";
      tds += `<td class="${outlierCls}">${fmt(v, desimal)}</td>`;
    }
    const nz = rowVals.filter((v) => v !== 0);
    const mean = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0;
    tds += `<td>${fmt(mean, desimal)}</td>`;
    tr.innerHTML = tds;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  blok.appendChild(table);
  return blok;
}

// Tabel "Rata-Rata ... menurut Kabupaten & Bulan/Triwulan" — satu baris
// per kabupaten (SEMUA 7 kab, bukan cuma yg dipilih), nilainya rata-rata
// antar kecamatan per periode. Outlier dihitung GLOBAL dari semua cell
// yang ada nilainya di tabel ini (semua kab x semua periode), nilai
// null/kosong tidak ikut dihitung — sama seperti logic buatTabelKecPeriode,
// dan pakai class warna "outlier" yang sama.
function buatTabelRata2PerKab({ judul, tab, cfg, rowsSemua, nPeriode, headerLabels, desimal = 2 }) {
  const labelAxis = cfg.periodeCol === "triwulan" ? "Triwulan" : "Bulan";
  const blok = document.createElement("div");
  blok.className = "tabel-blok";
  blok.innerHTML = `<div class="tabel-judul"><span>Rata-Rata ${judul} menurut Kabupaten &amp; ${labelAxis}</span></div>`;

  const table = document.createElement("table");
  table.className = "tabel-rekon";
  table.innerHTML = `<thead><tr>${["Kabupaten", ...headerLabels].map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = document.createElement("tbody");

  const perKabAvg = {}; // kab.id -> [rata2 per periode]
  const semuaNilai = []; // gabungan semua nilai valid (non-null) di seluruh tabel ini

  for (const kab of DAFTAR_KAB_BABEL) {
    const rowsKabIni = rowsSemua.filter((r) => r.nama_kab === kab.id);
    const kecKeys = Array.from(new Set(rowsKabIni.map((r) => r.kec)));
    const matrix = new Map();
    for (const r of rowsKabIni) {
      const per = Number(r[cfg.periodeCol]);
      matrix.set(`${r.kec}|${per}`, nilaiFromRow(r, tab));
    }

    const rataPerPeriode = [];
    for (let p = 1; p <= nPeriode; p++) {
      const vals = kecKeys.map((kid) => matrix.get(`${kid}|${p}`) ?? 0);
      const nz = vals.filter((v) => v !== 0);
      const rata = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : null;
      rataPerPeriode.push(rata);
      if (rata !== null) semuaNilai.push(rata);
    }
    perKabAvg[kab.id] = rataPerPeriode;
  }

  // Bounds outlier dihitung sekali dari SEMUA cell (bukan per baris)
  const [lo, hi] = iqrBounds(semuaNilai);

  for (const kab of DAFTAR_KAB_BABEL) {
    const rataPerPeriode = perKabAvg[kab.id];
    const tr = document.createElement("tr");
    let tds = `<td class="nama">${kab.nama}</td>`;
    rataPerPeriode.forEach((v) => {
      if (v === null) {
        tds += `<td>-</td>`;
      } else {
        const outlierCls = isOutlier(v, lo, hi) ? " outlier" : "";
        tds += `<td class="${outlierCls}">${fmt(v, desimal)}</td>`;
      }
    });
    tr.innerHTML = tds;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  blok.appendChild(table);
  return { blok, perKabAvg };
}

const PALET_WARNA = ["#1f9d6e", "#c0392b", "#2980b9", "#e67e22", "#8e44ad", "#16a085", "#d35400", "#7f8c8d", "#2c3e50", "#f39c12"];

function tambahkanGrafik(area, judul, labelsX, series, yTitle) {
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  const canvasId = "canvas-chart-" + Math.random().toString(36).slice(2);
  wrap.innerHTML = `<h4>${judul}</h4><canvas id="${canvasId}"></canvas>`;
  area.appendChild(wrap);

  const ctx = document.getElementById(canvasId).getContext("2d");
  const chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labelsX,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        borderColor: PALET_WARNA[i % PALET_WARNA.length],
        backgroundColor: PALET_WARNA[i % PALET_WARNA.length],
        spanGaps: true,
        tension: 0,
      })),
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: { y: { beginAtZero: true, title: { display: true, text: yTitle } } },
    },
  });
  state.chartInstances.push(chart);
}

function renderRekon(cfg, rowsKab, rowsSemua, komoditi) {
  const tab = cfg.tabs.find((t) => t.key === state.tabAktif) ?? cfg.tabs[0];
  const periodeCol = cfg.periodeCol;
  const nPeriode = cfg.periodeLabels.length;
  const headerLabels = cfg.periodeLabels.map((p) => (periodeCol === "triwulan" ? `Tw${p}` : p));
  const desimalUtama = tab.single === "harga_jual_petani" ? 0 : 2;

  const kecRows = pivotKec(rowsKab);
  const matrixUtama = new Map();
  for (const r of rowsKab) {
    const per = Number(r[periodeCol]);
    matrixUtama.set(`${r.kec}|${per}`, nilaiFromRow(r, tab));
  }

  const area = $("rekon-area");
  area.innerHTML = "";
  state.chartInstances.forEach((c) => c.destroy());
  state.chartInstances = [];

  // ---- Tabel utama (Provitas atau Harga) ----
  area.appendChild(buatTabelKecPeriode({
    judul: `${tab.label} — ${komoditi}`, satuan: tab.satuan,
    kecRows, matrix: matrixUtama, nPeriode, headerLabels, desimal: desimalUtama,
  }));

  // ---- Tabel raw (khusus tab provitas: Produksi & Luas/Tanaman) ----
  if (!tab.single && tab.rawNumer) {
    const matrixNumer = new Map();
    for (const r of rowsKab) {
      const per = Number(r[periodeCol]);
      matrixNumer.set(`${r.kec}|${per}`, (Number(r[tab.numer]) || 0) * (tab.rawNumer.factor ?? 1));
    }
    area.appendChild(buatTabelKecPeriode({
      judul: `${tab.rawNumer.label} — ${komoditi}`, satuan: tab.rawNumer.satuan,
      kecRows, matrix: matrixNumer, nPeriode, headerLabels, desimal: 2,
    }));
  }
  if (!tab.single && tab.rawDenom) {
    const matrixDenom = new Map();
    for (const r of rowsKab) {
      const per = Number(r[periodeCol]);
      matrixDenom.set(`${r.kec}|${per}`, (Number(r[tab.denom]) || 0) * (tab.rawDenom.factor ?? 1));
    }
    area.appendChild(buatTabelKecPeriode({
      judul: `${tab.rawDenom.label} — ${komoditi}`, satuan: tab.rawDenom.satuan,
      kecRows, matrix: matrixDenom, nPeriode, headerLabels, desimal: 2,
    }));
  }

  // ---- Tabel Rata-Rata menurut Kabupaten & Bulan/Triwulan (semua 7 kab) ----
  const { perKabAvg } = (() => {
    const r = buatTabelRata2PerKab({
      judul: `${tab.label} — ${komoditi}`, tab, cfg, rowsSemua, nPeriode, headerLabels, desimal: desimalUtama,
    });
    area.appendChild(r.blok);
    return r;
  })();

  // ---- Grafik per Kecamatan (kabupaten terpilih) ----
  tambahkanGrafik(
    area,
    `Grafik ${tab.label} per Kecamatan — ${komoditi}`,
    headerLabels,
    kecRows.map((k) => ({
      label: k.nama,
      data: Array.from({ length: nPeriode }, (_, idx) => matrixUtama.get(`${k.kode}|${idx + 1}`) ?? null),
    })),
    tab.satuan
  );

  // ---- Grafik Rata-Rata per Kabupaten (semua 7 kab) ----
  tambahkanGrafik(
    area,
    `Grafik Rata-Rata ${tab.label} per Kabupaten — ${komoditi}`,
    headerLabels,
    DAFTAR_KAB_BABEL.map((kab) => ({ label: kab.nama, data: perKabAvg[kab.id] })),
    tab.satuan
  );
}

// ============================================================
// Mulai
// ============================================================
cekSesiAwal();
