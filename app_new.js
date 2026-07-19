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
const KAB_ANOMALI_LIST = ["Bangka", "Belitung", "Bangka Barat", "Bangka Tengah", "Bangka Selatan", "Belitung Timur", "Kota Pangkalpinang"];

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
function fmtPersen(v) {
  if (v === null || v === undefined || !isFinite(v)) return "-";
  return v.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Kembalikan HTML <span> berwarna untuk nilai growth (persen).
// null -> "-" (strip), positif -> hijau, negatif -> merah, nol -> hitam biasa.
function fmtGrowthHtml(v, bold = false) {
  if (v === null || v === undefined || !isFinite(v)) {
    return bold ? `<strong>-</strong>` : `-`;
  }
  const teks = fmtPersen(v);
  let warna = "";
  if (v > 0) warna = `color:var(--hijau-muda);`;
  else if (v < 0) warna = `color:var(--merah);`;
  const inner = bold ? `<strong>${teks}</strong>` : teks;
  return warna ? `<span style="${warna}">${inner}</span>` : inner;
}
function normalisasiNamaTanaman(n) {
  return String(n ?? "").trim().toLowerCase();
}

// Baris "Group" (mis. "Cabai Besar (Group)", "Jamur (Group)") adalah
// gabungan/rekap dari komoditi lain yang SUDAH ikut dihitung sendiri2 di
// baris lain -- jadi harus TETAP ditampilkan di tabel Rangkuman, tapi
// TIDAK boleh ikut dijumlah ke baris TOTAL (supaya tidak dobel hitung).
function isNamaGroup(nama) {
  return /\(group\)/i.test(String(nama ?? ""));
}

// ============================================================
// AUTH — layar login penuh sebelum masuk, app-shell tampil setelahnya
// ============================================================
function tampilkanApp(masuk) {
  $("login-screen").classList.toggle("hidden", masuk);
  $("app-shell").classList.toggle("hidden", !masuk);
}

async function cekSesiAwal() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await masukKeApp();
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
    return;
  }

  state.profile = profile;

  // ---- Update UI: header ----
  const labelUser = `${profile.nama_tampil} (${profile.role === "prov" ? "Provinsi" : "Kab/Kota"})`;
  $("lbl-user").textContent = labelUser;
  $("lbl-user").classList.remove("hidden");
  $("btn-logout").classList.remove("hidden");
  $("info-terakhir").classList.remove("hidden");

  tampilkanApp(true);

  // ---- Toolbar Download Raw Data ----
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
  $("btn-download-rangkuman").disabled = false;

  isiPilihanTahun($("sel-tahun-rekon"));

  // ---- Upload Referensi ID Tanaman (khusus prov), ditaruh di toolbar atas ----
  $("wrap-referensi").classList.toggle("hidden", profile.role !== "prov");

  // ---- Panel Rangkuman: siapkan pilihan tahun & kabupaten ----
  isiPilihanTahun($("sel-tahun-rangkuman"));
  if (profile.role === "kabkot") {
    // Sama seperti panel Rekonsiliasi: kabkot dikunci ke kabupatennya
    // sendiri, tidak boleh pilih "Semua Kabupaten/Kota" atau kab lain.
    const namakabDB = profile.kab_id;
    const kabEntryRangkuman = DAFTAR_KAB_BABEL.find((k) => k.id === namakabDB);
    const labelKabRangkuman = kabEntryRangkuman ? kabEntryRangkuman.nama : namakabDB;
    $("sel-kab-rangkuman").innerHTML = `<option value="${namakabDB}">${labelKabRangkuman}</option>`;
    $("sel-kab-rangkuman").disabled = true;
  } else {
    $("sel-kab-rangkuman").disabled = false;
    $("sel-kab-rangkuman").innerHTML =
      `<option value="semua">— Semua Kabupaten/Kota (Provinsi) —</option>` +
      DAFTAR_KAB_BABEL.map((k) => `<option value="${k.id}">${k.nama}</option>`).join("");
  }

  // Bersihkan data Konfirmasi Anomali dari triwulan sebelumnya (kalau ada)
  try { await supabase.rpc("bersihkan_anomali_lama"); } catch (e) { /* diamkan, tidak kritis */ }

  siapkanSlicerAnomali();

  await muatReferensiIdTanaman();
  await siapkanKabSelect();
  await muatUlangJenis();
  await muatData(); // render otomatis begitu selesai login, tanpa perlu klik ulang dropdown

  mulaiRotasiInfo();

  // Kalau lagi buka view Rangkuman (mis. sisa state sebelumnya), muat juga
  if (!$("view-rangkuman").classList.contains("hidden")) {
    await muatRangkuman();
  }
}

function keluarDariApp() {
  state.profile = null;
  $("lbl-user").classList.add("hidden");
  $("btn-logout").classList.add("hidden");
  $("info-terakhir").classList.add("hidden");
  berhentiRotasiInfo();

  tampilkanApp(false);

  $("btn-download").disabled = true;
  $("btn-download-rangkuman").disabled = true;
  $("log-download-rangkuman").textContent = "";
  $("wrap-kab-download").classList.add("hidden");
  $("wrap-referensi").classList.add("hidden");
  $("in-file-referensi").value = "";
  $("log-referensi").textContent = "";
  $("log-download").textContent = "";

  $("in-username").value = "";
  $("in-password").value = "";
  $("login-error").textContent = "";

  // Reset panel kanan balik ke view Rekonsiliasi
  gantiView("rekon");
  $("rangkuman-area").innerHTML = `<div class="placeholder-kosong">Pilih jenis SPH, tahun & kabupaten untuk mulai.</div>`;
  $("anomali-area").innerHTML = `<div class="placeholder-kosong">Pilih jenis SPH & kabupaten untuk mulai.</div>`;
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

  if (!username || !password) {
    $("login-error").textContent = "Username & password wajib diisi.";
    return;
  }

  $("btn-login").disabled = true;
  $("btn-login").textContent = "Menyambungkan...";

  const email = username + EMAIL_DOMAIN;
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  $("btn-login").disabled = false;
  $("btn-login").textContent = "Sambungkan";

  if (error) {
    $("login-error").textContent = "Username atau password salah.";
    return;
  }
  await masukKeApp();
}

$("btn-logout").addEventListener("click", async () => {
  await supabase.auth.signOut();
  keluarDariApp();
});

// ============================================================
// TOGGLE PANEL KANAN: Rekonsiliasi <-> Rangkuman

// ============================================================
function gantiView(view) {
  $("view-rekon").classList.toggle("hidden", view !== "rekon");
  $("view-rangkuman").classList.toggle("hidden", view !== "rangkuman");
  $("view-anomali").classList.toggle("hidden", view !== "anomali");
  $("btn-view-rekon").classList.toggle("aktif", view === "rekon");
  $("btn-view-anomali").classList.toggle("aktif", view === "anomali");
  $("btn-view-rangkuman").classList.toggle("aktif", view === "rangkuman");
  $("toggle-aksi-rekon").classList.toggle("hidden", view !== "rekon");
  if (view === "rangkuman" && state.profile) muatRangkuman();
  if (view === "anomali" && state.profile) muatAnomali();
}
$("btn-view-rekon").addEventListener("click", () => gantiView("rekon"));
$("btn-view-anomali").addEventListener("click", () => gantiView("anomali"));
$("btn-view-rangkuman").addEventListener("click", () => gantiView("rangkuman"));

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

function bukaModalDownload() {
  $("modal-download").classList.remove("hidden");
}
function tutupModalDownload() {
  $("modal-download").classList.add("hidden");
}
$("btn-buka-download").addEventListener("click", bukaModalDownload);
$("btn-tutup-download").addEventListener("click", tutupModalDownload);
$("modal-download").addEventListener("click", (e) => {
  if (e.target.id === "modal-download") tutupModalDownload();
});

// Ambil semua baris mentah 1 jenis SPH utk 1 kombinasi tahun+kab.
async function ambilRowsMentah(jenis, tahun, kabNama) {
  const cfg = SPH_CONFIG[jenis];
  return await fetchAllRows((from, to) => {
    let query = supabase.from(cfg.table).select("*").eq("tahun", tahun);
    if (kabNama) query = query.eq("nama_kab", kabNama);
    return query
      .order(cfg.periodeCol, { ascending: true })
      .order("kab", { ascending: true })
      .order("urutkec", { ascending: true })
      .order("idtanaman", { ascending: true, nullsFirst: false })
      .range(from, to);
  });
}

// Susun baris Excel: kolom umum + kolom indikator dgn nama sesuai
// excelCols (mengandung kata kunci yang dicari fitur_rekon.py).
function buatRowsExcelMentah(cfg, rows) {
  return rows.map((r) => {
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
}

// Tulis 1 sheet data mentah ke workbook dgn styling: header hijau + teks
// putih bold, baris data selang-seling abu-abu (sama seperti sheet
// Rangkuman). rowsExcel = array of object (hasil buatRowsExcelMentah).
function tulisSheetDataMentah(wb, sheetName, rowsExcel) {
  if (!rowsExcel || rowsExcel.length === 0) return;
  const headers = Object.keys(rowsExcel[0]);
  const nCol = headers.length;
  const ws = {};
  const range = { s: { r: 0, c: 0 }, e: { r: 0, c: nCol - 1 } };

  const setCell = (r, c, cell) => {
    ws[XLSX.utils.encode_cell({ r, c })] = cell;
    if (r > range.e.r) range.e.r = r;
    if (c > range.e.c) range.e.c = c;
  };

  // Baris 0: header kolom (hijau, teks putih bold)
  headers.forEach((h, c) => {
    setCell(0, c, xlCell(h, { bold: true, bgColor: XL_HIJAU_HEADER, color: XL_PUTIH, align: "left" }));
  });

  // Baris data, selang-seling abu-abu tiap baris genap (0-indexed ganjil)
  rowsExcel.forEach((row, i) => {
    const stripeBg = i % 2 === 1 ? XL_ABU_STRIPE : undefined;
    headers.forEach((h, c) => {
      const v = row[h];
      const isNum = typeof v === "number";
      setCell(i + 1, c, xlCell(v, {
        bgColor: stripeBg,
        align: isNum ? "center" : "left",
        numFmt: isNum ? "#,##0.00" : undefined,
      }));
    });
  });

  ws["!ref"] = XLSX.utils.encode_range(range);
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

async function downloadData() {
  if (!state.profile) return;

  const jenisPilihan = $("sel-jenis-download").value; // bisa "semua" atau salah satu jenis
  const tahun = Number($("sel-tahun-download").value);
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

  const jenisList = jenisPilihan === "semua" ? ["sbs", "tbf", "th", "bst"] : [jenisPilihan];
  const labelKabFile = (kabNama ?? "SemuaKab").replace(/\s+/g, "");

  try {
    const wb = XLSX.utils.book_new();
    let totalRows = 0;
    const ringkasan = [];

    for (const jenis of jenisList) {
      const cfg = SPH_CONFIG[jenis];
      logBox.textContent = `Mengambil data ${cfg.label} tahun ${tahun} dari database...`;

      const rows = await ambilRowsMentah(jenis, tahun, kabNama);
      if (!rows || rows.length === 0) {
        ringkasan.push(`${cfg.label}: tidak ada data`);
        continue;
      }

      const rowsExcel = buatRowsExcelMentah(cfg, rows);
      // Untuk download 1 jenis saja, nama sheet "Sheet1" (spy tetap
      // kompatibel dgn menu "Pilih File Raw" di aplikasi desktop).
      // Untuk "Semua SPH", tiap jenis dapat tab tersendiri.
      const sheetName = jenisPilihan === "semua" ? cfg.label : "Sheet1";
      tulisSheetDataMentah(wb, sheetName, rowsExcel);
      totalRows += rows.length;
      ringkasan.push(`${cfg.label}: ${rows.length} baris`);
    }

    if (wb.SheetNames.length === 0) {
      logBox.textContent =
        `Tidak ada data tahun ${tahun}` +
        `${kabNama ? "" : " untuk seluruh kabupaten"}.\n` +
        `(Kemungkinan belum ada sinkronisasi dari aplikasi desktop.)`;
      return;
    }

    const namaFile = jenisPilihan === "semua"
      ? `SemuaSPH_${labelKabFile}_${tahun}.xlsx`
      : `${SPH_CONFIG[jenisPilihan].label}_${labelKabFile}_${tahun}.xlsx`;

    XLSX.writeFile(wb, namaFile, { cellStyles: true });

    // Catatan pemakaian di aplikasi desktop cuma relevan utk role "prov"
    // (yang juga pegang aplikasi desktop utk bikin Excel rekon dinamis).
    // Kabkot cukup tahu file-nya sudah jadi, tanpa embel-embel itu.
    const catatanDesktop = state.profile.role === "prov"
      ? `\nFile ini bisa langsung dipakai di aplikasi desktop FetSipedas ` +
        `(menu "3. Rekonsiliasi" → Pilih File Raw) untuk membuat Excel ` +
        `rekon dinamis (dengan dropdown & grafik).`
      : "";

    logBox.textContent =
      `✓ Selesai! ${totalRows} baris diexport ke "${namaFile}".\n` +
      `${ringkasan.join("\n")}` +
      catatanDesktop;
  } catch (e) {
    logBox.textContent = `✗ Gagal mengambil/export data: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download Raw Data (Excel)";
  }
}

// Info "terakhir diperbarui" TIDAK lagi bergantung dropdown yang dipilih --
// ditampilkan bergilir otomatis tiap 5 detik utk semua jenis SPH (tahun
// berjalan sekarang).
const JENIS_ROTASI_INFO = ["sbs", "tbf", "th", "bst"];
let infoRotasiIdx = 0;
let infoRotasiTimer = null;

async function muatInfoTerakhirUntuk(jenis, tahun) {
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

async function tampilkanInfoRotasiBerikutnya() {
  const jenis = JENIS_ROTASI_INFO[infoRotasiIdx % JENIS_ROTASI_INFO.length];
  infoRotasiIdx++;
  await muatInfoTerakhirUntuk(jenis, TAHUN_SEKARANG);
}

function mulaiRotasiInfo() {
  berhentiRotasiInfo();
  infoRotasiIdx = 0;
  tampilkanInfoRotasiBerikutnya();
  infoRotasiTimer = setInterval(tampilkanInfoRotasiBerikutnya, 5000);
}

function berhentiRotasiInfo() {
  if (infoRotasiTimer) { clearInterval(infoRotasiTimer); infoRotasiTimer = null; }
}

// ============================================================
// PANEL KANAN — VIEW: REKON
// ============================================================
$("sel-jenis").addEventListener("change", muatUlangJenis);
$("sel-tahun-rekon").addEventListener("change", async () => { await siapkanKabSelect(); await muatData(); });
$("sel-kab").addEventListener("change", async () => { await siapkanKomoditiSelect(); await muatData(); });
$("sel-komoditi").addEventListener("change", muatData);

async function muatUlangJenis() {
  if (!state.profile) return;
  siapkanTabBar();
  await siapkanKabSelect();
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
  const namaAsli = { sbs: [], bst: [], tbf: [], th: {} };

  // Kumpulkan per jenis, urut by urutan
  const perJenis = { sbs: [], bst: [], tbf: [], th: [] };
  if (data) {
    for (const row of data) {
      if (!map[row.jenis]) map[row.jenis] = {};
      map[row.jenis][normalisasiNamaTanaman(row.namatanaman)] = row.urutan;
      if (perJenis[row.jenis]) perJenis[row.jenis].push({ nama: row.namatanaman, urutan: row.urutan });
    }
  }
  // Urutkan nama asli sesuai urutan referensi
  for (const jenis of ["sbs", "bst", "tbf", "th"]) {
    perJenis[jenis].sort((a, b) => a.urutan - b.urutan);
    namaAsli[jenis] = perJenis[jenis].map((r) => r.nama);
  }

  state.idTanamanUrutan = map;
  state.idTanamanNamaAsli = namaAsli;
}

$("in-file-referensi")?.addEventListener("change", uploadReferensiIdTanaman);

async function uploadReferensiIdTanaman() {
  const fileInput = $("in-file-referensi");
  const logBox = $("log-referensi");
  const file = fileInput.files[0];

  if (!file) return;

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
    fileInput.value = "";
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

  const scrollAtas = document.createElement("div");
  scrollAtas.className = "scroll-atas";
  scrollAtas.innerHTML = `<div class="scroll-atas-dummy"></div>`;
  blok.appendChild(scrollAtas);

  const tabelScroll = document.createElement("div");
  tabelScroll.className = "tabel-scroll";
  blok.appendChild(tabelScroll);

  const konten = document.createElement("div");
  konten.className = "tabel-konten";
  konten.innerHTML = `<div class="tabel-judul"><span>${judul}</span><span class="satuan">${satuan}</span></div>`;
  tabelScroll.appendChild(konten);

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
  konten.appendChild(table);
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

  const scrollAtas = document.createElement("div");
  scrollAtas.className = "scroll-atas";
  scrollAtas.innerHTML = `<div class="scroll-atas-dummy"></div>`;
  blok.appendChild(scrollAtas);

  const tabelScroll = document.createElement("div");
  tabelScroll.className = "tabel-scroll";
  blok.appendChild(tabelScroll);

  const konten = document.createElement("div");
  konten.className = "tabel-konten";
  konten.innerHTML = `<div class="tabel-judul"><span>Rata-Rata ${judul} menurut Kabupaten &amp; ${labelAxis}</span></div>`;
  tabelScroll.appendChild(konten);

  const table = document.createElement("table");
  table.className = "tabel-rekon tabel-rata2";
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
  konten.appendChild(table);
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
      data: Array.from({ length: nPeriode }, (_, idx) => {
        const v = matrixUtama.get(`${k.kode}|${idx + 1}`) ?? null;
        return v === 0 ? null : v; // 0 = tidak ada data -> putus garis (spanGaps), bukan titik di angka 0
      }),
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

  initScrollAtas(area);
}

// Sinkronkan scrollbar tipis di ATAS tiap tabel dengan area scroll asli
// tabel itu (.tabel-scroll), supaya user bisa scroll ke kanan tanpa harus
// scroll ke bawah dulu buat cari scrollbar di bawah tabel yang panjang.
function initScrollAtas(container) {
  container.querySelectorAll(".tabel-blok").forEach((blok) => {
    const atas = blok.querySelector(".scroll-atas");
    const dummy = blok.querySelector(".scroll-atas-dummy");
    const scroll = blok.querySelector(".tabel-scroll");
    if (!atas || !dummy || !scroll || atas.dataset.terpasang) return;
    atas.dataset.terpasang = "1";
    dummy.style.width = scroll.scrollWidth + "px";
    atas.addEventListener("scroll", () => { scroll.scrollLeft = atas.scrollLeft; });
    scroll.addEventListener("scroll", () => { atas.scrollLeft = scroll.scrollLeft; });
  });
}

// ============================================================
// PANEL KANAN — VIEW: RANGKUMAN DATA
// ============================================================
// Total produksi per komoditi (dijumlah dari semua kecamatan, dan
// dijumlah dari semua kabupaten kalau dropdown Kabupaten = "semua"),
// dipecah per bulan (khusus SBS) & triwulan, plus growth q-to-q dan
// y-on-y. Growth dihitung dari "triwulan terakhir yang ada datanya":
//   - q-to-q = (TW ini - TW sebelumnya) / TW sebelumnya
//     (kalau TW ini = TW1, "TW sebelumnya" = TW4 tahun lalu)
//   - y-on-y = (TW ini - TW yang sama tahun lalu) / TW yang sama tahun lalu
// Makanya data tahun SEBELUMNYA juga selalu di-fetch di sini.
const BULAN_NAMA = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

$("sel-jenis-rangkuman").addEventListener("change", muatRangkuman);
$("sel-tahun-rangkuman").addEventListener("change", muatRangkuman);
$("sel-kab-rangkuman").addEventListener("change", muatRangkuman);

async function muatRangkuman() {
  if (!state.profile) return;
  const jenis = $("sel-jenis-rangkuman").value;
  const cfg = SPH_CONFIG[jenis];
  const rc = cfg.rangkuman;
  const tahun = Number($("sel-tahun-rangkuman").value);
  const kabPilihan = $("sel-kab-rangkuman").value; // "semua" atau nama_kab
  const area = $("rangkuman-area");

  if (!rc) {
    area.innerHTML = `<div class="placeholder-kosong">Jenis SPH ini belum didukung untuk Rangkuman Data.</div>`;
    return;
  }

  area.innerHTML = `<div class="placeholder-kosong">⏳ Memuat data...</div>`;

  const ambilTahun = (thn) =>
    fetchAllRows((from, to) => {
      let q = supabase
        .from(cfg.table)
        .select(`namatanaman, idtanaman, ${cfg.periodeCol}, ${rc.produksiCol}`)
        .eq("tahun", thn);
      if (kabPilihan !== "semua") q = q.eq("nama_kab", kabPilihan);
      return q.range(from, to);
    });

  let rowsIni = [], rowsLalu = [];
  try {
    [rowsIni, rowsLalu] = await Promise.all([ambilTahun(tahun), ambilTahun(tahun - 1)]);
  } catch (e) {
    area.innerHTML = `<div class="placeholder-kosong">Gagal memuat data: ${e.message}</div>`;
    return;
  }

  renderRangkuman(cfg, rc, rowsIni, rowsLalu, jenis, tahun, kabPilihan);
}

// Agregasi baris mentah -> Map<namatanaman, {idtanaman, bulan:{1..12}, tw:{1..4}}>
function agregasiRangkuman(cfg, rc, rows) {
  const map = new Map();
  for (const r of rows) {
    const nama = r.namatanaman;
    if (!nama) continue;
    if (!map.has(nama)) map.set(nama, { idtanaman: r.idtanaman ?? "", bulan: {}, tw: { 1: 0, 2: 0, 3: 0, 4: 0 } });
    const obj = map.get(nama);
    if (!obj.idtanaman && r.idtanaman) obj.idtanaman = r.idtanaman;

    const nilai = (Number(r[rc.produksiCol]) || 0) * (rc.factor ?? 1);

    if (cfg.periodeCol === "bulan") {
      const b = Number(r.bulan);
      if (b >= 1 && b <= 12) {
        obj.bulan[b] = (obj.bulan[b] || 0) + nilai;
        const tw = Math.ceil(b / 3);
        obj.tw[tw] = (obj.tw[tw] || 0) + nilai;
      }
    } else {
      const tw = Number(r.triwulan);
      if (tw >= 1 && tw <= 4) obj.tw[tw] = (obj.tw[tw] || 0) + nilai;
    }
  }
  return map;
}

// Cari indeks triwulan terakhir (1-4) yang punya nilai != 0
function twTerakhirAdaData(twObj) {
  for (let t = 4; t >= 1; t--) {
    if ((twObj[t] || 0) !== 0) return t;
  }
  return null;
}

// Hitung satu nilai growth (persen):
//   - pembilang ada, penyebut ada  -> rumus normal
//   - pembilang ada, penyebut = 0  -> +100 (naik dari nol)
//   - pembilang = 0, penyebut ada  -> -100 (turun ke nol)
//   - keduanya = 0                 -> null (tampil sebagai strip "-")
function hitungSatuGrowth(valNow, valBase) {
  if (valBase !== 0) return ((valNow - valBase) / valBase) * 100;
  if (valNow !== 0) return 100;
  return null; // 0/0 -> strip
}

// q-to-q, y-on-y, dan c-to-c (kumulatif vs kumulatif tahun lalu) dalam persen
function hitungGrowth(valNow, valPrevQ, valYoy, kumulIni, kumulLalu) {
  const qtoq  = hitungSatuGrowth(valNow,   valPrevQ);
  const yoy   = hitungSatuGrowth(valNow,   valYoy);
  const ctoc  = hitungSatuGrowth(kumulIni, kumulLalu);
  return { qtoq, yoy, ctoc };
}

function renderRangkuman(cfg, rc, rowsIni, rowsLalu, jenis, tahun, kabPilihan) {
  const area = $("rangkuman-area");
  const mapIni = agregasiRangkuman(cfg, rc, rowsIni);
  const mapLalu = agregasiRangkuman(cfg, rc, rowsLalu);

  if (mapIni.size === 0) {
    area.innerHTML =
      `<div class="placeholder-kosong">Tidak ada data ${cfg.label} tahun ${tahun}` +
      `${kabPilihan === "semua" ? "" : " untuk " + kabPilihan}.</div>`;
    return;
  }

  // Urutkan komoditi sesuai referensi id_tanaman (sama seperti dropdown Rekon)
  const urutanMap = state.idTanamanUrutan[jenis] || {};
  const namaList = Array.from(mapIni.keys()).sort((a, b) => {
    const ua = urutanMap[normalisasiNamaTanaman(a)];
    const ub = urutanMap[normalisasiNamaTanaman(b)];
    if (ua !== undefined && ub !== undefined) return ua - ub;
    if (ua !== undefined) return -1;
    if (ub !== undefined) return 1;
    return a.localeCompare(b, "id");
  });

  const pakaiBulan = cfg.periodeCol === "bulan";
  const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabPilihan);
  const labelKab = kabPilihan === "semua" ? "Semua Kabupaten/Kota (Provinsi)" : (kabEntry ? kabEntry.nama : kabPilihan);

  const BULAN_SINGKAT = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  let kolomHead = `<th>Kode</th><th>Nama</th><th>Satuan</th>`;
  if (pakaiBulan) kolomHead += BULAN_SINGKAT.map((b) => `<th>${b}</th>`).join("");
  kolomHead += `<th>TW 1</th><th>TW 2</th><th>TW 3</th><th>TW 4</th><th>Jumlah</th><th>q-to-q</th><th>y-on-y</th><th>c-to-c</th>`;

  const totalBulan = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 };
  const totalTw = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const totalTwLalu = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let totalKumulIni = 0, totalKumulLalu = 0;

  let bodyRows = "";
  namaList.forEach((nama) => {
    const d = mapIni.get(nama);
    const dLalu = mapLalu.get(nama) || { tw: { 1: 0, 2: 0, 3: 0, 4: 0 }, bulan: {} };
    const isGroup = isNamaGroup(nama); // baris "(Group)": tampil, tapi TIDAK ikut TOTAL

    const jumlah = (d.tw[1] || 0) + (d.tw[2] || 0) + (d.tw[3] || 0) + (d.tw[4] || 0);
    const jumlahLalu = (dLalu.tw[1] || 0) + (dLalu.tw[2] || 0) + (dLalu.tw[3] || 0) + (dLalu.tw[4] || 0);
    const twNow = twTerakhirAdaData(d.tw);

    // Kumulatif s.d. twNow (untuk c-to-c yang apple-to-apple)
    let kumulIni = 0, kumulLalu = 0;
    if (twNow !== null) {
      for (let t = 1; t <= twNow; t++) {
        kumulIni  += d.tw[t]    || 0;
        kumulLalu += dLalu.tw[t] || 0;
      }
    }

    let qtoq = null, yoy = null, ctoc = null;
    if (twNow !== null) {
      const valNow = d.tw[twNow] || 0;
      const valPrevQ = twNow === 1 ? (dLalu.tw[4] || 0) : (d.tw[twNow - 1] || 0);
      const valYoy = dLalu.tw[twNow] || 0;
      ({ qtoq, yoy, ctoc } = hitungGrowth(valNow, valPrevQ, valYoy, kumulIni, kumulLalu));
    }

    let tds = `<td>${d.idtanaman || "-"}</td><td class="nama">${nama}</td><td>${rc.satuan}</td>`;
    if (pakaiBulan) {
      for (let b = 1; b <= 12; b++) {
        const v = d.bulan[b] || 0;
        tds += `<td>${fmt(v, 2)}</td>`;
        if (!isGroup) totalBulan[b] += v;
      }
    }
    for (let t = 1; t <= 4; t++) {
      const v = d.tw[t] || 0;
      tds += `<td>${fmt(v, 2)}</td>`;
      if (!isGroup) totalTw[t] += v;
    }
    if (!isGroup) {
      for (let t = 1; t <= 4; t++) totalTwLalu[t] += (dLalu.tw[t] || 0);
      totalKumulIni  += kumulIni;
      totalKumulLalu += kumulLalu;
    }

    tds += `<td>${fmt(jumlah, 2)}</td>`;
    tds += `<td>${fmtGrowthHtml(qtoq)}</td>`;
    tds += `<td>${fmtGrowthHtml(yoy)}</td>`;
    tds += `<td>${fmtGrowthHtml(ctoc)}</td>`;

    bodyRows += `<tr>${tds}</tr>`;
  });

  // ---- Baris TOTAL ----
  const jumlahTotal = totalTw[1] + totalTw[2] + totalTw[3] + totalTw[4];
  const twNowTotal = twTerakhirAdaData(totalTw);
  let qtoqTotal = null, yoyTotal = null, ctocTotal = null;
  if (twNowTotal !== null) {
    const valNow = totalTw[twNowTotal];
    const valPrevQ = twNowTotal === 1 ? totalTwLalu[4] : totalTw[twNowTotal - 1];
    const valYoy = totalTwLalu[twNowTotal];
    ({ qtoq: qtoqTotal, yoy: yoyTotal, ctoc: ctocTotal } =
      hitungGrowth(valNow, valPrevQ, valYoy, totalKumulIni, totalKumulLalu));
  }

  let tdsTotal = `<td></td><td class="nama"><strong>TOTAL</strong></td><td></td>`;
  if (pakaiBulan) {
    for (let b = 1; b <= 12; b++) tdsTotal += `<td><strong>${fmt(totalBulan[b], 2)}</strong></td>`;
  }
  for (let t = 1; t <= 4; t++) tdsTotal += `<td><strong>${fmt(totalTw[t], 2)}</strong></td>`;
  tdsTotal += `<td><strong>${fmt(jumlahTotal, 2)}</strong></td>`;
  tdsTotal += `<td>${fmtGrowthHtml(qtoqTotal, true)}</td>`;
  tdsTotal += `<td>${fmtGrowthHtml(yoyTotal, true)}</td>`;
  tdsTotal += `<td>${fmtGrowthHtml(ctocTotal, true)}</td>`;

  area.innerHTML = `
    <div class="tabel-blok">
      <div class="scroll-atas"><div class="scroll-atas-dummy"></div></div>
      <div class="tabel-scroll">
        <div class="tabel-konten">
          <div class="tabel-judul">
            <span>Rangkuman Produksi ${cfg.label} — ${labelKab} — Tahun ${tahun}</span>
            <span class="satuan">Satuan: ${rc.satuan} · q-to-q, y-on-y &amp; c-to-c dalam %</span>
          </div>
          <table class="tabel-rekon tabel-rangkuman">
            <thead><tr>${kolomHead}</tr></thead>
            <tbody>${bodyRows}<tr>${tdsTotal}</tr></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  initScrollAtas(area);
}

// ============================================================
// DOWNLOAD RANGKUMAN EXCEL — semua jenis SPH dalam 1 file
// ============================================================
// Satu sheet per jenis SPH (SBS, BST, TBF, TH). Styling pakai
// SheetJS cell-level format: header hijau (#1f9d6e), judul kuning
// (#FFF176), growth positif hijau / negatif merah, baris total bold,
// border tipis semua cell -- semirip mungkin dengan tampilan web.

// Warna (ARGB tanpa #, format SheetJS)
const XL_HIJAU_HEADER = "FF1f9d6e"; // header kolom (sama dgn --hijau-muda)
const XL_KUNING_JUDUL = "FFFFF176"; // judul tabel (sama dgn .tabel-judul bg)
const XL_HIJAU_GROWTH = "FF1f9d6e"; // growth positif
const XL_MERAH_GROWTH = "FFc0392b"; // growth negatif (--merah)
const XL_TOTAL_BG     = "FFe8ede9"; // baris total (--abu2)
const XL_ABU_STRIPE   = "FFf8f8f8"; // selang-seling baris genap (sama dgn tr:nth-child(even) di web)
const XL_PUTIH        = "FFFFFFFF";

function xlBorder() {
  const s = { style: "thin", color: { rgb: "FFCCCCCC" } };
  return { top: s, bottom: s, left: s, right: s };
}

function xlCell(v, opts = {}) {
  // v bisa string/number/null. opts: bold, color (ARGB), bgColor (ARGB), align, numFmt
  const cell = { v: v ?? "", t: typeof v === "number" ? "n" : "s" };
  if (v === null || v === undefined) { cell.v = ""; cell.t = "s"; }
  const s = { border: xlBorder(), alignment: { horizontal: opts.align ?? "center", vertical: "center", wrapText: false } };
  if (opts.bold || opts.bgColor || opts.color) {
    s.font = {};
    if (opts.bold) s.font.bold = true;
    if (opts.color) s.font.color = { rgb: opts.color };
    if (opts.bgColor) { s.fill = { patternType: "solid", fgColor: { rgb: opts.bgColor } }; }
  }
  if (opts.numFmt) s.numFmt = opts.numFmt;
  cell.s = s;
  return cell;
}

// Hitung growth untuk satu komoditi/total, kembalikan {qtoq, yoy, ctoc}
function hitungGrowthXl(d, dLalu) {
  const twNow = twTerakhirAdaData(d.tw);
  if (twNow === null) return { qtoq: null, yoy: null, ctoc: null };
  const valNow   = d.tw[twNow] || 0;
  const valPrevQ = twNow === 1 ? (dLalu.tw[4] || 0) : (d.tw[twNow - 1] || 0);
  const valYoy   = dLalu.tw[twNow] || 0;
  let kumulIni = 0, kumulLalu = 0;
  for (let t = 1; t <= twNow; t++) { kumulIni += d.tw[t] || 0; kumulLalu += dLalu.tw[t] || 0; }
  return hitungGrowth(valNow, valPrevQ, valYoy, kumulIni, kumulLalu);
}

// Tulis satu sheet rangkuman ke workbook
function tulisSheetRangkuman(wb, sheetName, cfg, rc, rowsIni, rowsLalu, jenis, tahun, kabPilihan) {
  const mapIni  = agregasiRangkuman(cfg, rc, rowsIni);
  const mapLalu = agregasiRangkuman(cfg, rc, rowsLalu);

  const urutanMap = state.idTanamanUrutan[jenis] || {};
  const namaList  = Array.from(mapIni.keys()).sort((a, b) => {
    const ua = urutanMap[normalisasiNamaTanaman(a)];
    const ub = urutanMap[normalisasiNamaTanaman(b)];
    if (ua !== undefined && ub !== undefined) return ua - ub;
    if (ua !== undefined) return -1;
    if (ub !== undefined) return 1;
    return a.localeCompare(b, "id");
  });

  const pakaiBulan = cfg.periodeCol === "bulan";
  const kabEntry   = DAFTAR_KAB_BABEL.find((k) => k.id === kabPilihan);
  const labelKab   = kabPilihan === "semua"
    ? "Semua Kabupaten/Kota (Provinsi)"
    : (kabEntry ? kabEntry.nama : kabPilihan);

  // Susun kolom header
  const BULAN_SINGKAT_XL = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  const headers = ["Kode", "Nama", "Satuan"];
  if (pakaiBulan) BULAN_SINGKAT_XL.forEach((b) => headers.push(b));
  headers.push("TW 1", "TW 2", "TW 3", "TW 4", "Jumlah", "q-to-q (%)", "y-on-y (%)", "c-to-c (%)");

  const nCol = headers.length;
  const ws   = {};
  const range = { s: { r: 0, c: 0 }, e: { r: 0, c: nCol - 1 } };

  const setCell = (r, c, cell) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = cell;
    if (r > range.e.r) range.e.r = r;
    if (c > range.e.c) range.e.c = c;
  };

  // ---- Baris 0: judul tabel ----
  const judulTeks = `Rangkuman Produksi ${cfg.label} — ${labelKab} — Tahun ${tahun}  |  Satuan: ${rc.satuan} · q-to-q, y-on-y, c-to-c dalam %`;
  setCell(0, 0, xlCell(judulTeks, { bold: true, bgColor: XL_KUNING_JUDUL, align: "left" }));
  for (let c = 1; c < nCol; c++) setCell(0, c, xlCell("", { bgColor: XL_KUNING_JUDUL }));
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: nCol - 1 } }];

  // ---- Baris 1: header kolom ----
  headers.forEach((h, c) => {
    setCell(1, c, xlCell(h, { bold: true, bgColor: XL_HIJAU_HEADER, color: XL_PUTIH, align: c <= 2 ? "left" : "center" }));
  });

  // Indeks kolom growth (selalu 3 kolom terakhir)
  const iJumlah = nCol - 4;
  const iQtoQ   = nCol - 3;
  const iYoy    = nCol - 2;
  const iCtoc   = nCol - 1;

  const totalBulan = {};
  for (let b = 1; b <= 12; b++) totalBulan[b] = 0;
  const totalTw   = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const totalTwLalu = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let totalKumulIni = 0, totalKumulLalu = 0;

  let dataRow = 2;

  namaList.forEach((nama, iBaris) => {
    const d     = mapIni.get(nama);
    const dLalu = mapLalu.get(nama) || { tw: { 1: 0, 2: 0, 3: 0, 4: 0 }, bulan: {} };
    const { qtoq, yoy, ctoc } = hitungGrowthXl(d, dLalu);
    const isGroup = isNamaGroup(nama); // baris "(Group)": tampil, tapi TIDAK ikut TOTAL

    // Baris ke-2, ke-4, dst (0-indexed: ganjil) dikasih background abu-abu
    // tipis, sama seperti tr:nth-child(even) di tampilan web.
    const stripeBg = iBaris % 2 === 1 ? XL_ABU_STRIPE : undefined;

    // Kumulatif untuk total
    const twNow = twTerakhirAdaData(d.tw);
    let kumulIni = 0, kumulLalu = 0;
    if (twNow !== null) {
      for (let t = 1; t <= twNow; t++) { kumulIni += d.tw[t] || 0; kumulLalu += dLalu.tw[t] || 0; }
    }
    if (!isGroup) {
      totalKumulIni  += kumulIni;
      totalKumulLalu += kumulLalu;
    }

    let col = 0;
    setCell(dataRow, col++, xlCell(d.idtanaman || "-", { align: "left", bgColor: stripeBg }));
    setCell(dataRow, col++, xlCell(nama,               { align: "left", bgColor: stripeBg }));
    setCell(dataRow, col++, xlCell(rc.satuan,          { align: "left", bgColor: stripeBg }));

    if (pakaiBulan) {
      for (let b = 1; b <= 12; b++) {
        const v = d.bulan[b] || 0;
        if (!isGroup) totalBulan[b] += v;
        setCell(dataRow, col++, xlCell(v === 0 ? null : v, { numFmt: "#,##0.00", bgColor: stripeBg }));
      }
    }
    for (let t = 1; t <= 4; t++) {
      const v = d.tw[t] || 0;
      if (!isGroup) {
        totalTw[t]   += v;
        totalTwLalu[t] += (dLalu.tw[t] || 0);
      }
      setCell(dataRow, col++, xlCell(v === 0 ? null : v, { numFmt: "#,##0.00", bgColor: stripeBg }));
    }

    const jumlah = (d.tw[1]||0)+(d.tw[2]||0)+(d.tw[3]||0)+(d.tw[4]||0);
    setCell(dataRow, col++, xlCell(jumlah === 0 ? null : jumlah, { numFmt: "#,##0.00", bgColor: stripeBg }));

    // Growth cells — warna teks sesuai nilai (hijau naik / merah turun),
    // tetap dikasih stripeBg biar background baris tetap konsisten.
    const growthCell = (v) => {
      if (v === null) return xlCell("-", { bgColor: stripeBg });
      const color = v > 0 ? XL_HIJAU_GROWTH : v < 0 ? XL_MERAH_GROWTH : undefined;
      return xlCell(v, { numFmt: "#,##0.00", color, bgColor: stripeBg });
    };
    setCell(dataRow, col++, growthCell(qtoq));
    setCell(dataRow, col++, growthCell(yoy));
    setCell(dataRow, col++, growthCell(ctoc));

    dataRow++;
  });

  // ---- Baris TOTAL ----
  const totalD     = { tw: totalTw };
  const totalDLalu = { tw: totalTwLalu };
  const { qtoq: qtoqT, yoy: yoyT, ctoc: ctocT } = hitungGrowthXl(totalD, totalDLalu);
  // override kumulatif total (hitungGrowthXl pakai twTerakhir dari totalTw yg mungkin beda)
  // hitung ulang pakai totalKumulIni/Lalu yang sudah diakumulasi di loop
  const twNowTotal = twTerakhirAdaData(totalTw);
  let qtoqTf = null, yoyTf = null, ctocTf = null;
  if (twNowTotal !== null) {
    const vNow   = totalTw[twNowTotal];
    const vPrevQ = twNowTotal === 1 ? totalTwLalu[4] : totalTw[twNowTotal - 1];
    const vYoy   = totalTwLalu[twNowTotal];
    ({ qtoq: qtoqTf, yoy: yoyTf, ctoc: ctocTf } =
      hitungGrowth(vNow, vPrevQ, vYoy, totalKumulIni, totalKumulLalu));
  }

  let col = 0;
  setCell(dataRow, col++, xlCell("",       { bold: true, bgColor: XL_TOTAL_BG }));
  setCell(dataRow, col++, xlCell("TOTAL",  { bold: true, bgColor: XL_TOTAL_BG, align: "left" }));
  setCell(dataRow, col++, xlCell("",       { bold: true, bgColor: XL_TOTAL_BG }));

  if (pakaiBulan) {
    for (let b = 1; b <= 12; b++) {
      const v = totalBulan[b] || 0;
      setCell(dataRow, col++, xlCell(v === 0 ? null : v, { bold: true, bgColor: XL_TOTAL_BG, numFmt: "#,##0.00" }));
    }
  }
  for (let t = 1; t <= 4; t++) {
    const v = totalTw[t] || 0;
    setCell(dataRow, col++, xlCell(v === 0 ? null : v, { bold: true, bgColor: XL_TOTAL_BG, numFmt: "#,##0.00" }));
  }
  const jumlahTotal = (totalTw[1]||0)+(totalTw[2]||0)+(totalTw[3]||0)+(totalTw[4]||0);
  setCell(dataRow, col++, xlCell(jumlahTotal === 0 ? null : jumlahTotal, { bold: true, bgColor: XL_TOTAL_BG, numFmt: "#,##0.00" }));

  const growthTotalCell = (v) => {
    if (v === null) return xlCell("-", { bold: true, bgColor: XL_TOTAL_BG });
    const color = v > 0 ? XL_HIJAU_GROWTH : v < 0 ? XL_MERAH_GROWTH : undefined;
    return xlCell(v, { bold: true, bgColor: XL_TOTAL_BG, numFmt: "#,##0.00", color });
  };
  setCell(dataRow, col++, growthTotalCell(qtoqTf));
  setCell(dataRow, col++, growthTotalCell(yoyTf));
  setCell(dataRow, col++, growthTotalCell(ctocTf));

  ws["!ref"]  = XLSX.utils.encode_range(range);

  // Lebar kolom: Nama agak lebar, sisanya standar
  const colWidths = headers.map((h, i) => {
    if (i === 1) return { wch: 28 };  // Nama
    if (i === 2) return { wch: 10 };  // Satuan
    if (i === 0) return { wch: 14 };  // Kode
    return { wch: 11 };
  });
  ws["!cols"] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

async function downloadRangkumanExcel() {
  if (!state.profile) return;

  const tahun      = Number($("sel-tahun-rangkuman").value);
  const kabPilihan = $("sel-kab-rangkuman").value;
  const btn        = $("btn-download-rangkuman");
  const log        = $("log-download-rangkuman");

  btn.disabled = true;
  btn.textContent = "⏳ Mengambil data...";
  log.textContent = "Memuat semua jenis SPH...";

  const jenisUrutan = ["sbs", "bst", "tbf", "th"]; // urutan sheet di Excel

  try {
    // Fetch semua jenis + tahun lalu secara paralel
    const hasilFetch = await Promise.all(
      jenisUrutan.map(async (jenis) => {
        const cfg = SPH_CONFIG[jenis];
        const rc  = cfg.rangkuman;
        if (!rc) return { jenis, rowsIni: [], rowsLalu: [] };

        const ambil = (thn) => fetchAllRows((from, to) => {
          let q = supabase
            .from(cfg.table)
            .select(`namatanaman, idtanaman, ${cfg.periodeCol}, ${rc.produksiCol}`)
            .eq("tahun", thn);
          if (kabPilihan !== "semua") q = q.eq("nama_kab", kabPilihan);
          return q.range(from, to);
        });

        const [rowsIni, rowsLalu] = await Promise.all([ambil(tahun), ambil(tahun - 1)]);
        return { jenis, rowsIni, rowsLalu };
      })
    );

    log.textContent = "Menyusun Excel...";

    const wb = XLSX.utils.book_new();

    for (const { jenis, rowsIni, rowsLalu } of hasilFetch) {
      const cfg      = SPH_CONFIG[jenis];
      const rc       = cfg.rangkuman;
      if (!rc) continue;
      if (rowsIni.length === 0) continue; // skip jenis yang tidak ada datanya
      tulisSheetRangkuman(wb, cfg.label, cfg, rc, rowsIni, rowsLalu, jenis, tahun, kabPilihan);
    }

    if (wb.SheetNames.length === 0) {
      log.textContent = `Tidak ada data untuk tahun ${tahun}.`;
      return;
    }

    const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabPilihan);
    const labelKabFile = kabPilihan === "semua" ? "SemuaKab" : (kabEntry ? kabEntry.nama.replace(/\s+/g, "") : kabPilihan);
    const namaFile = `Rangkuman_SPH_${labelKabFile}_${tahun}.xlsx`;

    XLSX.writeFile(wb, namaFile, { bookSST: false, cellStyles: true });
    log.textContent = `✓ Selesai! ${wb.SheetNames.length} sheet (${wb.SheetNames.join(", ")}) → "${namaFile}"`;
    // Pesan sukses otomatis hilang setelah beberapa detik supaya tidak
    // nyangkut terus di layar walau usernya sudah pindah2 filter lain.
    setTimeout(() => {
      if (log.textContent.startsWith("✓ Selesai!")) log.textContent = "";
    }, 6000);
  } catch (e) {
    log.textContent = `✗ Gagal: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download Rangkuman Excel (Semua SPH)";
  }
}

$("btn-download-rangkuman").addEventListener("click", downloadRangkumanExcel);

// ============================================================
// PANEL KANAN — VIEW: KONFIRMASI ANOMALI
// ============================================================
$("sel-jenis-anomali").addEventListener("change", muatAnomali);
$("sel-kab-anomali").addEventListener("change", muatAnomali);

function isProv() { return state.profile?.role === "prov"; }

// Hitung TW saat ini berdasarkan bulan sekarang (dipakai sbg default
// pilihan di popup "Tambah Baris", & fallback saat parsing periode_teks).
function twSekarang() {
  return Math.ceil((new Date().getMonth() + 1) / 3);
}

// Daftar bulan dalam satu TW (1-indexed)
function bulanDalamTw(tw) {
  const start = (tw - 1) * 3 + 1;
  return [start, start + 1, start + 2];
}

const NAMA_BULAN = [
  "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// Buat label default periode: "TW2 2026"
function labelPeriodeDefault() {
  return `TW${twSekarang()} ${new Date().getFullYear()}`;
}

// Ambil daftar komoditi dari state.idTanamanUrutan untuk jenis yg sedang dipilih
function daftarKomoditiAnomali() {
  const jenis = $("sel-jenis-anomali").value;
  const urutanMap = state.idTanamanUrutan[jenis] || {};
  const entries = Object.entries(urutanMap); // [namaLower, urutan]
  // Kembalikan nama asli (Title Case) dari referensi — kita simpan juga nama asli
  // Karena idTanamanUrutan menyimpan nama lowercase sebagai key, kita butuh nama asli
  // Ambil dari state.idTanamanNamaAsli yang akan kita isi saat muatReferensiIdTanaman
  const namaAsli = state.idTanamanNamaAsli?.[jenis] || [];
  return namaAsli;
}

function siapkanSlicerAnomali() {
  const selKab = $("sel-kab-anomali");
  if (isProv()) {
    selKab.disabled = false;
    selKab.innerHTML = KAB_ANOMALI_LIST.map((k) => {
      const entry = DAFTAR_KAB_BABEL.find((d) => d.id === k);
      return `<option value="${k}">${entry ? entry.nama : k}</option>`;
    }).join("");
  } else {
    const namakabDB = state.profile.kab_id;
    const entry = DAFTAR_KAB_BABEL.find((d) => d.id === namakabDB);
    selKab.innerHTML = `<option value="${namakabDB}">${entry ? entry.nama : namakabDB}</option>`;
    selKab.disabled = true;
  }
  $("anomali-toolbar-prov").classList.toggle("hidden", !isProv());
  $("anomali-toolbar-kabkot").classList.toggle("hidden", isProv());
}

async function muatAnomali() {
  if (!state.profile) return;
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;
  const area = $("anomali-area");
  if (!kabId) return;

  area.innerHTML = `<div class="placeholder-kosong">⏳ Memuat data...</div>`;

  let rows;
  try {
    rows = await fetchAllRows((from, to) =>
      supabase
        .from("konfirmasi_anomali")
        .select("*")
        .eq("jenis", jenis).eq("kab_id", kabId)
        .order("no_urut", { ascending: true })
        .range(from, to)
    );
  } catch (e) {
    area.innerHTML = `<div class="placeholder-kosong">Gagal memuat data: ${e.message}</div>`;
    return;
  }
  renderAnomali(rows || []);
}

// Buat td dropdown bulan berdasarkan periode_teks (mis. "TW2 2026")
function buatTdBulan(rowId, periodeTeks, editable) {
  const td = document.createElement("td");

  // Parse TW dari periode_teks
  const matchTw = String(periodeTeks || "").match(/TW\s*(\d)/i);
  const tw = matchTw ? Number(matchTw[1]) : twSekarang();
  const bulanOptions = bulanDalamTw(tw);

  if (!editable) {
    td.classList.add("terkunci");
    td.textContent = ""; // kabkot tidak perlu lihat ini di sini
    return td;
  }

  const sel = document.createElement("select");
  sel.className = "sel-bulan-anomali";
  sel.style.cssText = "width:100%;padding:4px 6px;font-size:12px;border:1px solid #ccc;border-radius:4px;";
  sel.innerHTML = `<option value="">— Pilih —</option>` +
    bulanOptions.map((b) => `<option value="${b}">${NAMA_BULAN[b]}</option>`).join("");

  sel.addEventListener("change", async () => {
    await simpanKolomAnomali(rowId, "bulan", sel.value ? Number(sel.value) : null);
  });

  td.appendChild(sel);
  return td;
}

// Buat td dropdown komoditi dari referensi id_tanaman
function buatTdKomoditi(rowId, nilaiSaatIni, editable) {
  const td = document.createElement("td");

  if (!editable) {
    td.classList.add("terkunci");
    td.textContent = nilaiSaatIni || "";
    return td;
  }

  const namaList = daftarKomoditiAnomali();

  if (namaList.length === 0) {
    // Fallback: text editable biasa kalau referensi belum diupload
    td.contentEditable = "true";
    td.textContent = nilaiSaatIni || "";
    td.addEventListener("blur", async () => {
      await simpanKolomAnomali(rowId, "nama_komoditi", td.textContent.trim());
    });
    return td;
  }

  const sel = document.createElement("select");
  sel.className = "sel-komoditi-anomali";
  sel.style.cssText = "width:100%;padding:4px 6px;font-size:12px;border:1px solid #ccc;border-radius:4px;";
  sel.innerHTML = `<option value="">— Pilih —</option>` +
    namaList.map((n) => `<option value="${n}" ${n === nilaiSaatIni ? "selected" : ""}>${n}</option>`).join("");

  sel.addEventListener("change", async () => {
    await simpanKolomAnomali(rowId, "nama_komoditi", sel.value);
  });

  td.appendChild(sel);
  return td;
}

function renderAnomali(rows) {
  const area = $("anomali-area");
  const prov = isProv();

  if (rows.length === 0 && !prov) {
    area.innerHTML = `<div class="placeholder-kosong">Belum ada anomali yang ditandai Provinsi untuk kombinasi ini.</div>`;
    return;
  }

  const tbl = document.createElement("table");
  tbl.className = "tabel-anomali";
  tbl.innerHTML = `
    <thead><tr>
      <th class="col-no">No</th>
      <th class="col-periode">Periode</th>
      <th class="col-bulan">Bulan</th>
      <th>Nama Komoditi</th>
      <th>Kalimat Anomali</th>
      <th>Konfirmasi Kabkot</th>
      <th>Approval Provinsi</th>
      <th>Konfirmasi Ulang</th>
      ${prov ? `<th class="col-hapus"></th>` : ``}
    </tr></thead>`;
  const tbody = document.createElement("tbody");

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;

    const tdNo = editableTd(r.no_urut ?? "", "no_urut", prov, true);
    tdNo.classList.add("col-no");

    const tdPeriode = editableTd(r.periode_teks ?? "", "periode_teks", prov, false);
    tdPeriode.classList.add("col-periode");
    // Kalau periode berubah, perlu update dropdown bulan juga
    if (prov) {
      tdPeriode.addEventListener("blur", () => {
        // Update dropdown bulan di baris yang sama
        const tdBulanEl = tr.querySelector(".td-bulan");
        if (tdBulanEl) {
          const newTd = buatTdBulan(r.id, tdPeriode.textContent.trim(), prov);
          newTd.classList.add("td-bulan");
          tdBulanEl.replaceWith(newTd);
        }
      });
    }

    const tdBulan = buatTdBulan(r.id, r.periode_teks, prov);
    tdBulan.classList.add("td-bulan");
    // Set nilai yang sudah tersimpan kalau ada
    if (prov && r.bulan) {
      const sel = tdBulan.querySelector("select");
      if (sel) sel.value = String(r.bulan);
    }

    const tdKomoditi = buatTdKomoditi(r.id, r.nama_komoditi ?? "", prov);
    const tdKalimat = editableTd(r.kalimat_anomali ?? "", "kalimat_anomali", prov, false);
    const tdKabkot = editableTd(r.konfirmasi_kabkot ?? "", "konfirmasi_kabkot", !prov, false);

    const tdApproval = document.createElement("td");
    if (prov) {
      const sel = document.createElement("select");
      sel.className = "sel-approval approval-" + (r.approval_provinsi || "kosong");
      sel.innerHTML = `
        <option value="" ${!r.approval_provinsi ? "selected" : ""}>— Belum —</option>
        <option value="ya" ${r.approval_provinsi === "ya" ? "selected" : ""}>Ya</option>
        <option value="tidak" ${r.approval_provinsi === "tidak" ? "selected" : ""}>Tidak</option>`;
      sel.addEventListener("change", async () => {
        sel.className = "sel-approval approval-" + (sel.value || "kosong");
        await simpanKolomAnomali(r.id, "approval_provinsi", sel.value);
      });
      tdApproval.appendChild(sel);
    } else {
      tdApproval.textContent = r.approval_provinsi === "ya" ? "Ya" : r.approval_provinsi === "tidak" ? "Tidak" : "— Belum —";
      tdApproval.classList.add("terkunci");
    }

    const bolehIsiUlang = !prov && r.approval_provinsi === "tidak";
    const tdUlang = editableTd(r.konfirmasi_ulang ?? "", "konfirmasi_ulang", bolehIsiUlang, false);

    tr.appendChild(tdNo);
    tr.appendChild(tdPeriode);
    tr.appendChild(tdBulan);
    tr.appendChild(tdKomoditi);
    tr.appendChild(tdKalimat);
    tr.appendChild(tdKabkot);
    tr.appendChild(tdApproval);
    tr.appendChild(tdUlang);

    if (prov) {
      const tdHapus = document.createElement("td");
      tdHapus.className = "col-hapus";
      tdHapus.innerHTML = `<button class="btn-hapus-baris" title="Hapus baris">✕</button>`;
      tdHapus.querySelector("button").addEventListener("click", () => hapusBarisAnomali(r.id, tr));
      tr.appendChild(tdHapus);
    }

    tbody.appendChild(tr);
  });

  tbl.appendChild(tbody);
  area.innerHTML = "";
  area.appendChild(tbl);
}

function editableTd(value, field, editable, isNumber) {
  const td = document.createElement("td");
  td.textContent = value;
  if (!editable) {
    td.classList.add("terkunci");
    return td;
  }
  td.contentEditable = "true";
  td.addEventListener("blur", async () => {
    let v = td.textContent.trim();
    if (isNumber) v = Number(v) || 0;
    const tr = td.closest("tr");
    await simpanKolomAnomali(Number(tr.dataset.id), field, v);
  });
  return td;
}

async function simpanKolomAnomali(id, field, value) {
  try {
    const { error } = await supabase.from("konfirmasi_anomali").update({ [field]: value }).eq("id", id);
    if (error) throw error;
  } catch (e) {
    alert("Gagal menyimpan: " + e.message);
  }
}

async function hapusBarisAnomali(id, trEl) {
  if (!confirm("Hapus baris ini?")) return;
  try {
    const { error } = await supabase.from("konfirmasi_anomali").delete().eq("id", id);
    if (error) throw error;
    trEl.remove();
  } catch (e) {
    alert("Gagal menghapus: " + e.message);
  }
}

// ---- Tambah Baris: langsung insert baris baru pakai Triwulan & tahun
// berjalan sekarang (twSekarang()/TAHUN_SEKARANG), tanpa perlu popup lagi --
// kolom Periode sudah tidak ditampilkan di tabel, jadi gak perlu ditanya user. ----
$("btn-buka-tambah-anomali")?.addEventListener("click", async () => {
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;
  const rowsSaatIni = $("anomali-area").querySelectorAll("tbody tr").length;
  const periodeTeks = `TW${twSekarang()} ${TAHUN_SEKARANG}`;

  try {
    const { error } = await supabase.from("konfirmasi_anomali").insert({
      jenis, kab_id: kabId,
      no_urut: rowsSaatIni + 1,
      periode_teks: periodeTeks,
      nama_komoditi: "", kalimat_anomali: "",
    });
    if (error) throw error;
    await muatAnomali();
  } catch (e) {
    alert("Gagal menambah baris: " + e.message);
  }
});

// ---- Popup Hapus Semua Anomali: konfirmasi + opsi backup Excel dulu ----
function bukaModalHapusAnomali() {
  const jumlah = $("anomali-area").querySelectorAll("tbody tr").length;
  if (jumlah === 0) {
    alert("Tidak ada data anomali untuk kombinasi jenis SPH & kabupaten ini.");
    return;
  }
  $("teks-konfirmasi-hapus-anomali").textContent =
    `Akan menghapus ${jumlah} baris data anomali untuk kombinasi jenis SPH & kabupaten yang sedang dipilih. Tindakan ini tidak bisa dibatalkan.`;
  $("modal-hapus-anomali").classList.remove("hidden");
}
function tutupModalHapusAnomali() {
  $("modal-hapus-anomali").classList.add("hidden");
}
$("btn-buka-hapus-anomali")?.addEventListener("click", bukaModalHapusAnomali);
$("btn-tutup-hapus-anomali")?.addEventListener("click", tutupModalHapusAnomali);
$("btn-batal-hapus-anomali")?.addEventListener("click", tutupModalHapusAnomali);
$("modal-hapus-anomali")?.addEventListener("click", (e) => {
  if (e.target.id === "modal-hapus-anomali") tutupModalHapusAnomali();
});

async function hapusSemuaAnomali() {
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;
  try {
    const { error } = await supabase
      .from("konfirmasi_anomali")
      .delete()
      .eq("jenis", jenis)
      .eq("kab_id", kabId);
    if (error) throw error;
    tutupModalHapusAnomali();
    await muatAnomali();
  } catch (e) {
    alert("Gagal menghapus semua data: " + e.message);
  }
}

$("btn-konfirmasi-hapus-anomali")?.addEventListener("click", hapusSemuaAnomali);

$("btn-backup-lalu-hapus-anomali")?.addEventListener("click", async () => {
  const btn = $("btn-backup-lalu-hapus-anomali");
  btn.disabled = true;
  btn.textContent = "⏳ Mengunduh backup...";
  try {
    const berhasil = await downloadAnomaliExcel();
    if (berhasil) {
      await hapusSemuaAnomali();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download Backup Excel, lalu Hapus";
  }
});

// ---- Upload Excel (khusus prov): kolom Periode, No, Nama Komoditi, Kalimat Anomali ----
$("in-file-anomali")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rowsSheet = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const daftar = rowsSheet.map((row, i) => {
      const bulanRaw = row["Bulan"] ?? row.bulan ?? "";
      const bulanVal = bulanRaw !== "" ? (Number(bulanRaw) || null) : null;
      return {
        jenis, kab_id: kabId,
        periode_teks: String(row["Periode"] ?? row.periode ?? "").trim(),
        no_urut: Number(row.No ?? row.no ?? i + 1) || (i + 1),
        bulan: bulanVal,
        nama_komoditi: String(row["Nama Komoditi"] ?? row.nama_komoditi ?? "").trim(),
        kalimat_anomali: String(row["Kalimat Anomali"] ?? row.kalimat_anomali ?? "").trim(),
      };
    }).filter((r) => r.nama_komoditi || r.kalimat_anomali);

    if (daftar.length === 0) {
      alert("Tidak ada baris valid di file Excel. Pastikan ada kolom 'Periode', 'No', 'Nama Komoditi', 'Kalimat Anomali'.");
      return;
    }

    const { error } = await supabase.from("konfirmasi_anomali").insert(daftar);
    if (error) throw error;
    await muatAnomali();
  } catch (err) {
    alert("Gagal upload Excel: " + err.message);
  } finally {
    e.target.value = "";
  }
});

// ---- Download Excel (prov & kabkot) ----
$("btn-download-anomali")?.addEventListener("click", downloadAnomaliExcel);
$("btn-download-anomali-kabkot")?.addEventListener("click", downloadAnomaliExcel);

async function downloadAnomaliExcel() {
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;

  let rows;
  try {
    rows = await fetchAllRows((from, to) =>
      supabase.from("konfirmasi_anomali").select("*")
        .eq("jenis", jenis).eq("kab_id", kabId)
        .order("no_urut", { ascending: true }).range(from, to)
    );
  } catch (e) {
    alert("Gagal mengambil data: " + e.message);
    return false;
  }
  if (!rows || rows.length === 0) {
    alert("Tidak ada data untuk didownload.");
    return false;
  }

  const wb = XLSX.utils.book_new();
  const headers = ["No", "Periode", "Bulan", "Nama Komoditi", "Kalimat Anomali", "Konfirmasi Kabkot", "Approval Provinsi", "Konfirmasi Ulang"];
  const ws = {};
  const range = { s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } };
  const setCell = (r, c, cell) => { ws[XLSX.utils.encode_cell({ r, c })] = cell; };

  headers.forEach((h, c) => setCell(0, c, xlCell(h, { bold: true, bgColor: XL_HIJAU_HEADER, color: XL_PUTIH, align: "left" })));
  rows.forEach((r, i) => {
    const stripeBg = i % 2 === 1 ? XL_ABU_STRIPE : undefined;
    const bulanLabel = r.bulan ? (NAMA_BULAN[r.bulan] || r.bulan) : "";
    const vals = [
      r.no_urut, r.periode_teks, bulanLabel, r.nama_komoditi, r.kalimat_anomali, r.konfirmasi_kabkot,
      r.approval_provinsi === "ya" ? "Ya" : r.approval_provinsi === "tidak" ? "Tidak" : "",
      r.konfirmasi_ulang,
    ];
    vals.forEach((v, c) => setCell(i + 1, c, xlCell(v, { align: c <= 1 ? "center" : "left", bgColor: stripeBg })));
  });

  ws["!ref"] = XLSX.utils.encode_range(range);
  ws["!cols"] = [{ wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 24 }, { wch: 40 }, { wch: 30 }, { wch: 16 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, "Anomali");

  const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabId);
  const labelKab = (kabEntry ? kabEntry.nama : kabId).replace(/\s+/g, "");
  XLSX.writeFile(wb, `KonfirmasiAnomali_${jenis.toUpperCase()}_${labelKab}.xlsx`, { cellStyles: true });
  return true;
}

// ============================================================
// Mulai
// ============================================================
cekSesiAwal();
