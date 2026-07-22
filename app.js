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
  anomaliRows: [],   // baris anomali yang sedang dimuat (sebelum disort utk render)
  anomaliSort: { kolom: "no_urut", arah: "asc" }, // sort aktif tabel Konfirmasi Anomali
  kecamatanPerKab: {}, // cache: kab_id -> [nama_kec, ...] (utk dropdown Kecamatan di Anomali)
};

const TAHUN_AWAL = 2018;
const TAHUN_SEKARANG = new Date().getFullYear();
const KAB_ANOMALI_LIST = ["Bangka", "Belitung", "Bangka Barat", "Bangka Selatan", "Bangka Tengah", "Belitung Timur", "Kota Pangkal Pinang"];

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

// Auto-tinggikan textarea (combo Kecamatan/Komoditi) supaya teks yang
// tidak muat 1 baris otomatis lanjut ke baris berikutnya di bawah,
// bukan kepotong.
function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// ============================================================
// Loading donut (menggantikan teks "⏳ Memuat data...") — donut
// muter dengan persentase perkiraan di tengah. Persentase ini BUKAN
// progress asli (kita tidak tahu progress request ke Supabase), cuma
// perkiraan yang naik cepat di awal lalu melambat mendekati 90%
// (sengaja tidak pernah nyampe 100% karena belum tentu selesai) --
// begitu data beneran datang, konten area diganti (innerHTML lain)
// dan timer otomatis berhenti sendiri begitu elemen svg-nya sudah
// tidak ada lagi di DOM.
function mulaiLoadingDonut(container, teks) {
  const id = "donut-" + Math.random().toString(36).slice(2);
  const circumference = 2 * Math.PI * 26;
  container.innerHTML = `
    <div class="loading-donut-wrap">
      <svg class="loading-donut" viewBox="0 0 64 64">
        <circle class="donut-bg" cx="32" cy="32" r="26"></circle>
        <circle class="donut-fg" id="${id}-circle" cx="32" cy="32" r="26"
          stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"></circle>
      </svg>
      <div class="loading-donut-pct" id="${id}-pct">0%</div>
      ${teks ? `<div class="loading-donut-teks">${teks}</div>` : ""}
    </div>`;

  let pct = 0;
  const timer = setInterval(() => {
    const circle = document.getElementById(`${id}-circle`);
    const pctEl = document.getElementById(`${id}-pct`);
    if (!circle || !pctEl) { clearInterval(timer); return; }
    const sisa = 90 - pct;
    pct += Math.max(0.4, sisa * 0.09);
    if (pct > 90) pct = 90;
    circle.style.strokeDashoffset = String(circumference * (1 - pct / 100));
    pctEl.textContent = Math.round(pct) + "%";
  }, 120);
  return timer;
}

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
    .select("id, username, role, kab_id, nama_tampil, akses_terbatas")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    $("login-error").textContent = "Akun ditemukan tapi profil belum terdaftar. Hubungi admin.";
    await supabase.auth.signOut();
    return;
  }

  state.profile = profile;

  // ---- Update UI: header ----
  // Label di pojok kanan header sekarang menunjukkan peran akun secara
  // eksplisit (bukan nama_tampil bebas lagi):
  // - prov penuh (mis. sphbps19)      -> "Super Admin Provinsi"
  // - prov akses_terbatas (mis. sph1900) -> "Admin Provinsi"
  // - kabkot (mis. sph1971, dst)      -> "Admin <Nama Kabupaten/Kota>"
  //   (tanpa prefix "Kota"/"Kab." -- mis. "Kota Pangkal Pinang" jadi
  //   cukup "Admin Pangkal Pinang").
  let labelUser;
  if (profile.role === "prov") {
    labelUser = profile.akses_terbatas ? "Admin Provinsi" : "Super Admin Provinsi";
  } else {
    const namaKabBersih = String(profile.kab_id || "").replace(/^Kota\s+/i, "");
    labelUser = `Admin ${namaKabBersih}`;
  }
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

  // ---- Upload Referensi ID Tanaman (khusus prov, dan BUKAN prov yang
  // "akses_terbatas" -- akun seperti sph1900 tampilannya sama seperti
  // provinsi biasa, tapi tidak boleh mengubah referensi ID Tanaman). ----
  $("wrap-referensi").classList.toggle("hidden", profile.role !== "prov" || profile.akses_terbatas === true);

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

  mulaiLoadingDonut(area);

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

  mulaiLoadingDonut(area);

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
    btn.textContent = "⬇ Download Tabulasi Data SPH";
  }
}

$("btn-download-rangkuman").addEventListener("click", downloadRangkumanExcel);

// ============================================================
// PANEL KANAN — VIEW: KONFIRMASI ANOMALI
// ============================================================
$("sel-jenis-anomali").addEventListener("change", muatAnomali);
$("sel-kab-anomali").addEventListener("change", muatAnomali);

function isProv() { return state.profile?.role === "prov"; }

// Akun provinsi "terbatas" (mis. sph1900): tampilannya SAMA seperti
// provinsi biasa (role tetap "prov", bisa lihat semua kab, download
// Excel, edit/approve baris yang sudah ada), TAPI tidak boleh menambah
// baris baru & tidak boleh upload Excel massal di Konfirmasi Anomali,
// serta tidak boleh upload Referensi ID Tanaman di panel Rekon (lihat
// masukKeApp()). Ditandai lewat kolom profiles.akses_terbatas di DB.
function isProvTerbatas() { return isProv() && state.profile?.akses_terbatas === true; }

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

// Ambil daftar nama kecamatan utk 1 kabupaten (dipakai dropdown Kecamatan
// di Konfirmasi Anomali) -- diambil dari data_* yang sudah tersinkron
// (gabungan semua jenis SPH, supaya lengkap), lalu di-cache per kab_id
// biar tidak query ulang tiap render.
async function muatKecamatanKab(kabId) {
  if (state.kecamatanPerKab[kabId]) return state.kecamatanPerKab[kabId];
  const tabel = ["data_sbs", "data_bst", "data_tbf", "data_th"];
  let semua = [];
  for (const t of tabel) {
    try {
      const rows = await fetchAllRows((from, to) =>
        supabase.from(t).select("nama_kec, urutkec").eq("nama_kab", kabId).range(from, to)
      );
      semua = semua.concat(rows || []);
    } catch (e) { /* tabel/kab ini mungkin belum ada data -- lewati */ }
  }
  // PENTING: sumber data kadang menulis nama kecamatan yang SAMA dengan
  // ejaan beda antar tabel/jenis SPH -- bukan cuma beda kapitalisasi
  // (mis. "MENDO BARAT" vs "Mendo Barat"), tapi juga beda spasi (mis.
  // "SUNGAILIAT" vs "Sungai Liat"). Daripada menebak ejaan mana yang
  // "lebih rapi", ejaan yang dipakai utk ditampilkan adalah ejaan yang
  // PALING SERING muncul di data asli (paling banyak barisnya di
  // database) -- jadi benar-benar mengikuti data sebenarnya, bukan
  // tebakan format.
  const keyKec = (n) => normalisasiNamaTanaman(n).replace(/\s+/g, "");
  const grup = new Map(); // key -> { urutan, varian: Map<namaAsli, jumlah> }
  for (const r of semua) {
    if (!r.nama_kec) continue;
    const key = keyKec(r.nama_kec);
    if (!grup.has(key)) grup.set(key, { urutan: r.urutkec ?? 0, varian: new Map() });
    const g = grup.get(key);
    g.varian.set(r.nama_kec, (g.varian.get(r.nama_kec) || 0) + 1);
  }
  const list = Array.from(grup.values())
    .sort((a, b) => a.urutan - b.urutan)
    .map((g) => {
      // Pilih varian ejaan dengan jumlah kemunculan TERBANYAK di data.
      let namaTerbanyak = null, jumlahTerbanyak = -1;
      for (const [nama, jumlah] of g.varian.entries()) {
        if (jumlah > jumlahTerbanyak) { namaTerbanyak = nama; jumlahTerbanyak = jumlah; }
      }
      return namaTerbanyak;
    });
  state.kecamatanPerKab[kabId] = list;
  return list;
}

function siapkanSlicerAnomali() {
  const selKab = $("sel-kab-anomali");
  if (isProv()) {
    selKab.disabled = false;
    selKab.innerHTML =
      `<option value="semua">— Semua Kabupaten/Kota —</option>` +
      KAB_ANOMALI_LIST.map((k) => {
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

  // Khusus prov "akses_terbatas" (mis. sph1900): sembunyikan tombol
  // "+ Tambah Baris" & "Upload Excel" -- sisanya (download, hapus
  // terpilih, hapus semua, dashboard, edit/approve baris yang sudah
  // ada) tetap seperti provinsi biasa.
  if (isProv()) {
    const terbatas = isProvTerbatas();
    $("btn-buka-tambah-anomali").classList.toggle("hidden", terbatas);
    $("btn-buka-generate-anomali").classList.toggle("hidden", terbatas);
    $("lbl-upload-anomali").classList.toggle("hidden", terbatas);
    // Akun prov terbatas (mis. sph1900) tidak boleh menghapus baris
    // sama sekali -- baik satu-satu (X per baris, kolom checkboxnya
    // sudah otomatis hilang lewat provFull di renderAnomali) maupun
    // massal (Hapus Terpilih / Hapus Semua Anomali).
    $("btn-hapus-terpilih-anomali").classList.toggle("hidden", terbatas);
    $("btn-buka-hapus-anomali").classList.toggle("hidden", terbatas);
  }
}

async function muatAnomali() {
  if (!state.profile) return;
  state.dashboardAnomaliAktif = false;
  perbaruiTombolDashboardAnomali();
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;
  const area = $("anomali-area");
  if (!kabId) return;

  // Mode "semua kabupaten/kota": ambil data dari semua kab sekaligus,
  // urutkan berdasarkan urutan KAB_ANOMALI_LIST (1901/Bangka dulu) lalu no_urut.
  const modeSemua = kabId === "semua";

  // Nonaktifkan tombol "+ Tambah Baris" SEGERA begitu mode "Semua"
  // dipilih -- jangan tunggu render selesai di renderAnomali()
  // (sebelumnya tombol ini sempat kelihatan aktif/hijau selama proses
  // loading masih berjalan, padahal begitu data selesai dimuat langsung
  // didisable juga -- jadi lebih baik didisable dari awal).
  if (isProv() && !isProvTerbatas()) {
    const btnTambah = $("btn-buka-tambah-anomali");
    if (btnTambah) {
      btnTambah.disabled = modeSemua;
      btnTambah.title = modeSemua ? "Pilih kabupaten spesifik untuk menambah baris" : "";
    }
    // Upload Excel TIDAK perlu didisable di mode "Semua Kabupaten/Kota"
    // lagi -- kabupaten sekarang dibaca otomatis dari kolom
    // "Kabupaten/Kota" di tiap baris file (lihat handler
    // in-file-anomali), jadi aman diklik di mode manapun.
  }

  mulaiLoadingDonut(area);

  let rows;
  try {
    if (modeSemua) {
      // Ambil SEMUA kab SEKALIGUS secara paralel (Promise.all) --
      // sebelumnya diambil satu-satu berurutan (7 kab gantian), yang
      // bikin loading lama padahal masing2 query-nya sendiri cepat.
      // Promise.all tetap mengembalikan array sesuai urutan INPUT
      // (KAB_ANOMALI_LIST), bukan sesuai kab mana yang selesai duluan,
      // jadi urutan hasil gabungan tetap sama seperti sebelumnya.
      const hasilPerKab = await Promise.all(
        KAB_ANOMALI_LIST.map((kab) =>
          fetchAllRows((from, to) =>
            supabase
              .from("konfirmasi_anomali")
              .select("*")
              .eq("jenis", jenis).eq("kab_id", kab)
              .order("no_urut", { ascending: true })
              .range(from, to)
          )
        )
      );
      rows = hasilPerKab.flat();
    } else {
      rows = await fetchAllRows((from, to) =>
        supabase
          .from("konfirmasi_anomali")
          .select("*")
          .eq("jenis", jenis).eq("kab_id", kabId)
          .order("no_urut", { ascending: true })
          .range(from, to)
      );
    }
  } catch (e) {
    area.innerHTML = `<div class="placeholder-kosong">Gagal memuat data: ${e.message}</div>`;
    return;
  }
  state.anomaliRows = rows || [];

  if (modeSemua) {
    // Ambil daftar kecamatan semua kab SEKALIGUS (paralel juga, bukan
    // berurutan) -- muatKecamatanKab sudah punya cache per kab_id
    // sendiri, jadi aman dipanggil bareng-bareng.
    const daftarPerKab = await Promise.all(KAB_ANOMALI_LIST.map((kab) => muatKecamatanKab(kab)));
    const daftarKecGabung = daftarPerKab.flat();
    // Deduplikasi berdasarkan key (case-insensitive, tanpa spasi)
    const seen = new Set();
    state.daftarKecAktif = daftarKecGabung.filter((n) => {
      const key = normalisasiNamaTanaman(n).replace(/\s+/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } else {
    state.daftarKecAktif = await muatKecamatanKab(kabId);
  }

  renderAnomaliSorted();
}

// ---- Sorting tabel Konfirmasi Anomali ----
// Kolom "bulan" WAJIB disort numerik dari nilai aslinya (1-12), BUKAN
// dari label teksnya ("Jan","Feb",...) -- supaya urutannya benar
// (Jan=1 s.d. Des=12), bukan alfabetis (Agu, Apr, Des, Feb, ...).
const KOLOM_ANOMALI_SORTABLE = [
  { key: "no_urut", label: "No", tipe: "angka" },
  { key: "kecamatan", label: "Kecamatan", tipe: "teks" },
  { key: "nama_komoditi", label: "Nama Komoditi", tipe: "teks" },
  { key: "bulan", label: "Bulan", tipe: "angka" },
  { key: "kalimat_anomali", label: "Anomali", tipe: "teks" },
  { key: "tindak_lanjut", label: "Tindak Lanjut", tipe: "teks" },
  { key: "konfirmasi_kabkot", label: null, tipe: "teks" }, // label kolom ini dinamis (nama kab), lihat renderAnomali
  { key: "approval_provinsi", label: "Approval Provinsi", tipe: "teks" },
];

function bandingkanAnomali(a, b, kolom, tipe, arah) {
  let va = a[kolom];
  let vb = b[kolom];
  if (tipe === "angka") {
    // null/undefined selalu di bawah, terlepas arah sort
    const na = va === null || va === undefined;
    const nb = vb === null || vb === undefined;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    va = Number(va); vb = Number(vb);
    return arah === "asc" ? va - vb : vb - va;
  }
  va = String(va ?? "").toLowerCase();
  vb = String(vb ?? "").toLowerCase();
  const cmp = va.localeCompare(vb, "id");
  return arah === "asc" ? cmp : -cmp;
}

function renderAnomaliSorted() {
  const { kolom, arah } = state.anomaliSort;
  const info = KOLOM_ANOMALI_SORTABLE.find((k) => k.key === kolom);
  const tipe = info ? info.tipe : "teks";
  const rowsSorted = [...state.anomaliRows].sort((a, b) => bandingkanAnomali(a, b, kolom, tipe, arah));
  renderAnomali(rowsSorted);
}

// Baca nilai kolom LANGSUNG dari isi yang sedang tampil di DOM (bukan dari
// cache state.anomaliRows) -- supaya sort selalu akurat sesuai apa yang
// benar-benar dilihat user saat ini, termasuk isian yang baru saja
// diketik/dipilih tapi belum tentu "settle" di cache.
function nilaiKolomDariBarisAnomali(tr, kolom) {
  const tds = tr.children;
  const adaChk = !!tr.querySelector(".chk-anomali");
  const adaKabKol = $("sel-kab-anomali")?.value === "semua";
  // Urutan kolom sekarang: [checkbox?] [No] [Kabupaten?] [Kecamatan]
  // [Komoditi] [Bulan] [Kalimat] [TindakLanjut] [Kabkot] [Approval] --
  // "No" cuma digeser oleh checkbox (Kabupaten SEKARANG ada SETELAH
  // No, bukan sebelumnya), sedangkan kolom2 lain (Kecamatan dst)
  // digeser oleh checkbox DAN kolom Kabupaten.
  const offsetNo = adaChk ? 1 : 0;
  const offset = offsetNo + (adaKabKol ? 1 : 0);

  // Kolom Kabupaten (hanya mode semua) -- ambil dari dataset tr
  if (kolom === "_kab") {
    return tr.dataset.kabId || "";
  }

  switch (kolom) {
    case "no_urut": {
      const txt = (tds[offsetNo]?.textContent || "").trim();
      return txt === "" ? null : Number(txt);
    }
    case "kecamatan": {
      const input = tds[0 + offset]?.querySelector(".combo-input, .combo-input-wrap");
      return (input ? input.value : tds[0 + offset]?.textContent || "").trim();
    }
    case "nama_komoditi": {
      const input = tds[1 + offset]?.querySelector(".combo-input, .combo-input-wrap");
      return (input ? input.value : tds[1 + offset]?.textContent || "").trim();
    }
    case "bulan": {
      const input = tds[2 + offset]?.querySelector(".combo-input");
      const txt = (input ? input.value : tds[2 + offset]?.textContent || "").trim();
      const jenisAktif = $("sel-jenis-anomali").value;
      const idx = daftarPeriodeAnomali(jenisAktif).indexOf(txt);
      return idx >= 0 ? idx + 1 : null;
    }
    case "kalimat_anomali":
      return (tds[3 + offset]?.textContent || "").trim();
    case "tindak_lanjut": {
      const sel = tds[4 + offset]?.querySelector("select");
      return (sel ? sel.value : tds[4 + offset]?.textContent || "").trim();
    }
    case "konfirmasi_kabkot":
      return (tds[5 + offset]?.textContent || "").trim();
    case "approval_provinsi": {
      const sel = tds[6 + offset]?.querySelector("select");
      return (sel ? sel.value : tds[6 + offset]?.textContent || "").trim();
    }
    default:
      return "";
  }
}

function bandingkanNilaiAnomali(va, vb, tipe, arah) {
  if (tipe === "angka") {
    const na = va === null || va === undefined;
    const nb = vb === null || vb === undefined;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return arah === "asc" ? va - vb : vb - va;
  }
  // Kolom "Kabupaten" (mode Semua): sort mengikuti urutan KODE kabupaten
  // (1901 Bangka s.d. 1971 Kota Pangkal Pinang, lihat KAB_ANOMALI_LIST),
  // BUKAN alfabetis -- supaya konsisten dgn urutan default tampilan.
  if (tipe === "kab") {
    const ia = KAB_ANOMALI_LIST.indexOf(va);
    const ib = KAB_ANOMALI_LIST.indexOf(vb);
    const na = ia === -1, nb = ib === -1;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return arah === "asc" ? ia - ib : ib - ia;
  }
  const sa = String(va ?? "").toLowerCase();
  const sb = String(vb ?? "").toLowerCase();
  const cmp = sa.localeCompare(sb, "id");
  return arah === "asc" ? cmp : -cmp;
}

// Urutkan ulang baris <tr> yang SUDAH ADA di tabel Anomali dengan
// memindah posisinya di DOM (appendChild pada node yang sama memindah,
// bukan membuat ulang) -- input/select/isi yang sedang tampil di layar
// jadi TIDAK PERNAH ikut dibuat ulang atau hilang saat sort diklik.
function urutkanBarisAnomaliDiDom(kolom, arah) {
  const tbody = document.querySelector("#anomali-area table.tabel-anomali tbody");
  if (!tbody) return;
  const info = KOLOM_ANOMALI_SORTABLE.find((k) => k.key === kolom);
  // Kolom _kab tidak ada di KOLOM_ANOMALI_SORTABLE, tapi tipenya teks
  const tipe = info ? info.tipe : "teks";
  const trs = Array.from(tbody.children);
  trs.sort((ta, tb) => {
    const va = nilaiKolomDariBarisAnomali(ta, kolom);
    const vb = nilaiKolomDariBarisAnomali(tb, kolom);
    return bandingkanNilaiAnomali(va, vb, kolom === "_kab" ? "kab" : tipe, arah);
  });
  trs.forEach((tr) => tbody.appendChild(tr));

  // Mode "Semua Kabupaten/Kota": kolom No selalu jalan urut 1,2,3,...
  // mengikuti urutan tampil SEKARANG (bukan no_urut asli dari database,
  // yang direset per kabupaten jadi 1,1,1,...) -- jadi tiap kali baris
  // dipindah urutannya lewat sort di atas, kolom No ikut dinomori ulang.
  if ($("sel-kab-anomali")?.value === "semua") {
    const trsBaru = Array.from(tbody.children);
    trsBaru.forEach((tr, idx) => {
      const adaChk = !!tr.querySelector(".chk-anomali");
      const tdNo = tr.children[adaChk ? 1 : 0];
      if (tdNo) tdNo.textContent = String(idx + 1);
    });
  }
}

// Update teks header (label + panah ▲▼) sesuai kolom/arah sort aktif,
// tanpa menyentuh <tbody> sama sekali.
function perbaruiLabelHeaderAnomali() {
  const table = document.querySelector("#anomali-area table.tabel-anomali");
  if (!table) return;
  const { kolom: kolomAktif, arah: arahAktif } = state.anomaliSort;
  const modeSemua = $("sel-kab-anomali")?.value === "semua";
  const jenisAktif = $("sel-jenis-anomali").value;
  const labelKonfirmasiKol = modeSemua ? "Konfirmasi Kabkot" : `Konfirmasi ${labelKabAnomaliAktif()}`;
  const labelKolom = { _kab: "Kabupaten", no_urut: "No", kecamatan: "Kecamatan", bulan: labelKolomPeriodeAnomali(jenisAktif), nama_komoditi: "Nama Komoditi", kalimat_anomali: "Anomali", tindak_lanjut: "Tindak Lanjut", konfirmasi_kabkot: labelKonfirmasiKol, approval_provinsi: "Approval Provinsi" };
  table.querySelectorAll("thead th.th-sortable").forEach((th) => {
    const key = th.dataset.kolom;
    const panah = kolomAktif === key ? (arahAktif === "asc" ? " ▲" : " ▼") : "";
    th.textContent = (labelKolom[key] ?? "") + panah;
  });
}

// Buat td dropdown Bulan -- SEKARANG bebas pilih semua 12 bulan (tidak
// dibatasi ke TW tertentu lagi), dan sekarang jadi combobox ketik+cari
// (bukan <select> native) -- alasan sama kayak Komoditi: <select> browser
// suka kebuka ke ATAS kalau space-nya dianggap kurang, dan gak bisa
// diketik cari. Nama bulan disingkat (Jan, Feb, dst) biar muat & gampang
// diketik cari ("jan" langsung ketemu).
const BULAN_SINGKAT_ANOMALI = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
const TRIWULAN_LABEL_ANOMALI = ["Tw1", "Tw2", "Tw3", "Tw4"];

// SPH-SBS pakai periode Bulan (1-12), sedangkan SPH-BST/TBF/TH pakai
// Triwulan (1-4) -- sama seperti tabel data_* masing2 jenis. Kolom di
// database "konfirmasi_anomali" TETAP bernama "bulan" (tidak perlu
// migrasi skema), cuma nilainya diinterpretasikan beda tergantung jenis
// SPH yang sedang aktif: 1-12 utk SBS, 1-4 utk BST/TBF/TH.
function daftarPeriodeAnomali(jenis) {
  return jenis === "sbs" ? BULAN_SINGKAT_ANOMALI : TRIWULAN_LABEL_ANOMALI;
}
function labelKolomPeriodeAnomali(jenis) {
  return jenis === "sbs" ? "Bulan" : "Triwulan";
}

function buatTdBulan(rowId, bulanSaatIni, editable, jenis) {
  const daftarPeriode = daftarPeriodeAnomali(jenis);
  const td = document.createElement("td");

  if (!editable) {
    td.classList.add("terkunci");
    // Sebelumnya kolom ini sengaja dikosongkan utk role kabkot -- itu
    // keliru: kabkot tetap perlu MELIHAT bulan/triwulan anomali (cuma
    // tidak boleh MENGEDIT-nya, makanya pakai class "terkunci" bukan
    // combo).
    td.textContent = bulanSaatIni ? (daftarPeriode[bulanSaatIni - 1] || "") : "";
    return td;
  }

  const labelSaatIni = bulanSaatIni ? daftarPeriode[bulanSaatIni - 1] : "";

  const wrap = document.createElement("div");
  wrap.className = "combo-wrap";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "combo-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = jenis === "sbs" ? "Cari bulan..." : "Cari triwulan...";
  input.value = labelSaatIni;

  const list = document.createElement("div");
  // Dropdown Bulan/Triwulan isinya cuma teks pendek (mis. "Jan", "Tw2"),
  // jadi TIDAK perlu selebar dropdown Kecamatan/Komoditi -- dikasih
  // class "combo-list-sempit" supaya ngepas ikut isinya saja (lihat
  // style.css: .combo-list-sempit override min-width/max-width).
  list.className = "combo-list combo-list-sempit hidden";

  let labelTersimpan = labelSaatIni;

  function renderList(filterTeks) {
    const q = normalisasiNamaTanaman(filterTeks || "");
    const hasil = q
      ? daftarPeriode.filter((n) => normalisasiNamaTanaman(n).includes(q))
      : daftarPeriode;
    list.innerHTML = hasil.length
      ? hasil.map((n) => `<div class="combo-option" data-nama="${n}">${n}</div>`).join("")
      : `<div class="combo-empty">(tidak ada yang cocok)</div>`;
    list.classList.remove("hidden");
  }

  async function pilihBulan(labelBulan) {
    input.value = labelBulan;
    labelTersimpan = labelBulan;
    list.classList.add("hidden");
    const nomor = daftarPeriode.indexOf(labelBulan) + 1;
    await simpanKolomAnomali(rowId, "bulan", nomor || null);
  }

  input.addEventListener("focus", () => { renderList(""); input.select(); });
  input.addEventListener("input", () => renderList(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const opsiPertama = list.querySelector(".combo-option");
      if (opsiPertama) {
        pilihBulan(opsiPertama.dataset.nama);
      } else {
        input.value = labelTersimpan;
        list.classList.add("hidden");
      }
      input.blur();
    } else if (e.key === "Escape") {
      input.value = labelTersimpan;
      list.classList.add("hidden");
      input.blur();
    }
  });

  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt) return;
    e.preventDefault();
    pilihBulan(opt.dataset.nama);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      list.classList.add("hidden");
      const ketikan = input.value.trim();
      if (ketikan === labelTersimpan) return;
      const cocok = daftarPeriode.find((n) => normalisasiNamaTanaman(n) === normalisasiNamaTanaman(ketikan));
      if (cocok) {
        pilihBulan(cocok);
      } else {
        input.value = labelTersimpan; // gak cocok -> batal, balik ke nilai lama
      }
    }, 150);
  });

  wrap.appendChild(input);
  wrap.appendChild(list);
  td.appendChild(wrap);
  return td;
}

// ============================================================
// Combobox Komoditi -- input teks yang bisa diketik/dicari (bukan
// <select> native lagi). Kenapa diganti: <select> native browser suka
// buka ke ATAS kalau space di bawah dianggap kurang (perhitungan
// browser, bukan kita yang atur), dan gak bisa diketik cari. Combobox
// custom ini: dropdown-nya SELALU nempel di BAWAH input (position:
// absolute, top:100%), bisa diketik buat filter list-nya, Enter buat
// pilih hasil teratas, klik pilihan juga bisa.
// ============================================================
function buatTdKomoditi(rowId, nilaiSaatIni, editable) {
  const td = document.createElement("td");

  if (!editable) {
    td.classList.add("terkunci");
    td.textContent = nilaiSaatIni || "";
    return td;
  }

  const namaList = daftarKomoditiAnomali();

  // Fallback: kalau referensi id_tanaman belum diupload provinsi, tetap
  // pakai sel biasa contenteditable (teks bebas).
  if (namaList.length === 0) {
    td.contentEditable = "true";
    td.spellcheck = false; // matikan garis merah spellcheck bawaan browser
    td.textContent = nilaiSaatIni || "";
    td.addEventListener("blur", async () => {
      await simpanKolomAnomali(rowId, "nama_komoditi", td.textContent.trim());
    });
    return td;
  }

  const wrap = document.createElement("div");
  wrap.className = "combo-wrap";

  const input = document.createElement("textarea");
  input.spellcheck = false;
  input.rows = 1;
  input.className = "combo-input-wrap";
  input.autocomplete = "off";
  input.placeholder = "Ketik utk cari...";
  input.value = nilaiSaatIni || "";
  input.addEventListener("input", () => autoGrowTextarea(input));

  const list = document.createElement("div");
  list.className = "combo-list hidden";

  let nilaiTersimpan = nilaiSaatIni || "";

  function renderList(filterTeks) {
    const q = normalisasiNamaTanaman(filterTeks || "");
    const hasil = q
      ? namaList.filter((n) => normalisasiNamaTanaman(n).includes(q))
      : namaList;
    if (hasil.length === 0) {
      list.innerHTML = `<div class="combo-empty">(tidak ada yang cocok)</div>`;
    } else {
      list.innerHTML = hasil.map((n) =>
        `<div class="combo-option" data-nama="${n.replace(/"/g, "&quot;")}">${n}</div>`
      ).join("");
    }
    list.classList.remove("hidden");
  }

  async function pilihNama(nama) {
    input.value = nama;
    nilaiTersimpan = nama;
    list.classList.add("hidden");
    autoGrowTextarea(input);
    await simpanKolomAnomali(rowId, "nama_komoditi", nama);
  }

  input.addEventListener("focus", () => { renderList(""); input.select(); });
  input.addEventListener("input", () => renderList(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const opsiPertama = list.querySelector(".combo-option");
      if (opsiPertama) {
        pilihNama(opsiPertama.dataset.nama);
      } else {
        // Ketikan gak cocok satupun -- balikin ke nilai tersimpan terakhir
        input.value = nilaiTersimpan;
        list.classList.add("hidden");
      }
      input.blur();
    } else if (e.key === "Escape") {
      input.value = nilaiTersimpan;
      list.classList.add("hidden");
      input.blur();
    }
  });

  // mousedown (bukan click) supaya kepilih SEBELUM event blur di input nembak
  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt) return;
    e.preventDefault();
    pilihNama(opt.dataset.nama);
  });

  input.addEventListener("blur", () => {
    // Kasih jeda dikit -- kalau blur ini dipicu klik opsi, mousedown di
    // atas sudah keburu jalan duluan (preventDefault mencegah blur
    // membatalkan klik). Kalau bukan, cocokkan ketikan bebas ke list.
    setTimeout(() => {
      list.classList.add("hidden");
      const ketikan = input.value.trim();
      if (ketikan === nilaiTersimpan) return;
      const cocok = namaList.find((n) => normalisasiNamaTanaman(n) === normalisasiNamaTanaman(ketikan));
      if (cocok) {
        pilihNama(cocok);
      } else {
        // Gak cocok ke referensi manapun -- batalkan, balik ke nilai lama
        input.value = nilaiTersimpan;
      }
    }, 150);
  });

  wrap.appendChild(input);
  wrap.appendChild(list);
  td.appendChild(wrap);
  requestAnimationFrame(() => autoGrowTextarea(input));
  return td;
}

// Combobox Kecamatan -- pola sama persis dgn buatTdKomoditi/buatTdBulan:
// ketik+cari, dropdown SELALU nempel di bawah input. Daftar kecamatan
// otomatis mengikuti kabupaten yang sedang aktif di dropdown "sel-kab-anomali"
// (diambil lewat muatKecamatanKab, lihat pemanggilnya di muatAnomali()).
function buatTdKecamatan(rowId, nilaiSaatIni, editable, daftarKec) {
  const td = document.createElement("td");

  if (!editable) {
    td.classList.add("terkunci");
    td.textContent = nilaiSaatIni || "";
    return td;
  }

  if (!daftarKec || daftarKec.length === 0) {
    // Fallback: belum ada data kecamatan tersinkron utk kab ini -- pakai
    // sel bebas ketik biasa.
    td.contentEditable = "true";
    td.spellcheck = false; // matikan garis merah spellcheck bawaan browser
    td.textContent = nilaiSaatIni || "";
    td.addEventListener("blur", async () => {
      await simpanKolomAnomali(rowId, "kecamatan", td.textContent.trim());
    });
    return td;
  }

  const wrap = document.createElement("div");
  wrap.className = "combo-wrap";

  const input = document.createElement("textarea");
  input.spellcheck = false;
  input.rows = 1;
  input.className = "combo-input-wrap";
  input.autocomplete = "off";
  input.placeholder = "Ketik utk cari...";
  input.value = nilaiSaatIni || "";
  input.addEventListener("input", () => autoGrowTextarea(input));

  const list = document.createElement("div");
  list.className = "combo-list hidden";

  let nilaiTersimpan = nilaiSaatIni || "";

  function renderList(filterTeks) {
    const q = normalisasiNamaTanaman(filterTeks || "");
    const hasil = q ? daftarKec.filter((n) => normalisasiNamaTanaman(n).includes(q)) : daftarKec;
    list.innerHTML = hasil.length
      ? hasil.map((n) => `<div class="combo-option" data-nama="${n.replace(/"/g, "&quot;")}">${n}</div>`).join("")
      : `<div class="combo-empty">(tidak ada yang cocok)</div>`;
    list.classList.remove("hidden");
  }

  async function pilihNama(nama) {
    input.value = nama;
    nilaiTersimpan = nama;
    list.classList.add("hidden");
    autoGrowTextarea(input);
    await simpanKolomAnomali(rowId, "kecamatan", nama);
  }

  input.addEventListener("focus", () => { renderList(""); input.select(); });
  input.addEventListener("input", () => renderList(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const opsiPertama = list.querySelector(".combo-option");
      if (opsiPertama) {
        pilihNama(opsiPertama.dataset.nama);
      } else {
        input.value = nilaiTersimpan;
        list.classList.add("hidden");
      }
      input.blur();
    } else if (e.key === "Escape") {
      input.value = nilaiTersimpan;
      list.classList.add("hidden");
      input.blur();
    }
  });

  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt) return;
    e.preventDefault();
    pilihNama(opt.dataset.nama);
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      list.classList.add("hidden");
      const ketikan = input.value.trim();
      if (ketikan === nilaiTersimpan) return;
      const cocok = daftarKec.find((n) => normalisasiNamaTanaman(n) === normalisasiNamaTanaman(ketikan));
      if (cocok) {
        pilihNama(cocok);
      } else {
        input.value = nilaiTersimpan;
      }
    }, 150);
  });

  wrap.appendChild(input);
  wrap.appendChild(list);
  td.appendChild(wrap);
  requestAnimationFrame(() => autoGrowTextarea(input));
  return td;
}

// Kolom Label (G/M) -- G = digenerate otomatis dari deteksi outlier,
// M = ditambahkan manual (baik lewat "+ Tambah Baris" maupun upload
// Excel). Read-only, cuma tampil utk provinsi PENUH (provFull), tidak
// pernah tampil utk sph1900 (prov terbatas) atau kabkot.
function buatTdLabelSumber(sumber) {
  const td = document.createElement("td");
  td.className = "col-label terkunci";
  const nilai = sumber === "G" ? "G" : "M";
  const judul = nilai === "G" ? "Generated (otomatis dari outlier)" : "Manual (input langsung)";
  td.innerHTML = `<span class="label-sumber label-sumber-${nilai.toLowerCase()}" title="${judul}">${nilai}</span>`;
  return td;
}

// Dropdown Tindak Lanjut -- cuma 2 pilihan (Wajar / Perbaikan), jadi
// cukup <select> native biasa (bukan combobox ketik+cari).
function buatTdTindakLanjut(rowId, nilaiSaatIni, editable) {
  const td = document.createElement("td");
  if (!editable) {
    td.classList.add("terkunci");
    td.textContent = nilaiSaatIni === "wajar" ? "Wajar" : nilaiSaatIni === "perbaikan" ? "Perbaikan" : "";
    return td;
  }
  const sel = document.createElement("select");
  sel.className = "sel-tindak-lanjut";
  sel.innerHTML = `
    <option value="" ${!nilaiSaatIni ? "selected" : ""}>Belum</option>
    <option value="wajar" ${nilaiSaatIni === "wajar" ? "selected" : ""}>Wajar</option>
    <option value="perbaikan" ${nilaiSaatIni === "perbaikan" ? "selected" : ""}>Perbaikan</option>`;
  sel.addEventListener("change", async () => {
    await simpanKolomAnomali(rowId, "tindak_lanjut", sel.value);
  });
  td.appendChild(sel);
  return td;
}

// Label kabupaten yang sedang aktif di panel Anomali -- dipakai buat
// judul kolom "Konfirmasi <Nama Kab>" biar otomatis ganti sesuai
// kabupaten yang dipilih (atau kab_id sendiri kalau role kabkot).
function labelKabAnomaliAktif() {
  const kabId = $("sel-kab-anomali").value;
  if (kabId === "semua") return "Semua Kabupaten/Kota";
  const entry = DAFTAR_KAB_BABEL.find((d) => d.id === kabId);
  return entry ? entry.nama : (kabId || "Kabkot");
}

function renderAnomali(rows) {
  const area = $("anomali-area");
  const prov = isProv();
  // provFull: provinsi dengan akses PENUH (bukan akun terbatas seperti
  // sph1900) -- cuma provFull yang boleh centang baris & hapus baris
  // satu-satu (kolom checkbox + tombol ✕).
  const provFull = prov && !isProvTerbatas();
  const kabIdAktif = $("sel-kab-anomali").value;
  const modeSemua = kabIdAktif === "semua";
  const labelKab = labelKabAnomaliAktif();
  const jenisAktif = $("sel-jenis-anomali").value;

  // Mode semua: tombol Tambah Baris dinonaktifkan (harus pilih kab dulu)
  if (prov && !isProvTerbatas()) {
    const btnTambah = $("btn-buka-tambah-anomali");
    if (btnTambah) {
      btnTambah.disabled = modeSemua;
      btnTambah.title = modeSemua ? "Pilih kabupaten spesifik untuk menambah baris" : "";
    }
  }

  if (rows.length === 0 && !prov) {
    area.innerHTML = `<div class="placeholder-kosong">Belum ada anomali yang ditandai Provinsi untuk kombinasi ini.</div>`;
    return;
  }
  if (rows.length === 0 && prov) {
    area.innerHTML = `<div class="placeholder-kosong">Belum ada data anomali untuk pilihan ini.</div>`;
    return;
  }

  const tbl = document.createElement("table");
  tbl.className = "tabel-anomali";

  const { kolom: kolomAktif, arah: arahAktif } = state.anomaliSort;
  // Kalau mode semua, judul kolom konfirmasi kabkot dibuat generik
  const labelKonfirmasiKol = modeSemua ? "Konfirmasi Kabkot" : `Konfirmasi ${labelKab}`;
  const labelKolom = { no_urut: "No", kecamatan: "Kecamatan", bulan: labelKolomPeriodeAnomali(jenisAktif), nama_komoditi: "Nama Komoditi", kalimat_anomali: "Anomali", tindak_lanjut: "Tindak Lanjut", konfirmasi_kabkot: labelKonfirmasiKol, approval_provinsi: "Approval Provinsi" };
  const clsExtra = {
    no_urut: "col-no",
    kecamatan: "col-kecamatan",
    bulan: "col-bulan",
    nama_komoditi: "col-komoditi",
    kalimat_anomali: "col-anomali",
    tindak_lanjut: "col-tindak-lanjut",
    konfirmasi_kabkot: "col-kabkot",
    approval_provinsi: "col-approval",
  };

  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  if (provFull) {
    const thChk = document.createElement("th");
    thChk.className = "col-chk";
    const chkSemua = document.createElement("input");
    chkSemua.type = "checkbox";
    chkSemua.id = "chk-semua-anomali";
    chkSemua.title = "Pilih/batalkan semua baris";
    chkSemua.addEventListener("change", () => {
      document.querySelectorAll("#anomali-area .chk-anomali").forEach((c) => { c.checked = chkSemua.checked; });
    });
    thChk.appendChild(chkSemua);
    trHead.appendChild(thChk);
  }
  KOLOM_ANOMALI_SORTABLE.forEach(({ key, tipe }) => {
    const th = document.createElement("th");
    th.className = "th-sortable" + (clsExtra[key] ? " " + clsExtra[key] : "");
    th.dataset.kolom = key;
    const panah = kolomAktif === key ? (arahAktif === "asc" ? " ▲" : " ▼") : "";
    th.textContent = labelKolom[key] + panah;
    th.addEventListener("click", () => {
      if (state.anomaliSort.kolom === key) {
        state.anomaliSort.arah = state.anomaliSort.arah === "asc" ? "desc" : "asc";
      } else {
        state.anomaliSort = { kolom: key, arah: "asc" };
      }
      // PENTING: sort di sini TIDAK membangun ulang tabel dari cache
      // (state.anomaliRows) -- itu penyebab data yang baru saja
      // diketik/dipilih tapi belum "settle" di cache jadi kelihatan
      // hilang. Sebagai gantinya, baris <tr> yang SUDAH ADA di layar
      // cukup dipindah urutannya di DOM (tanpa dibuat ulang), dan
      // nilai pembanding dibaca LANGSUNG dari isian yang sedang
      // tampil di layar -- jadi apa pun yang sedang ditampilkan
      // (termasuk yang belum sempat tersimpan) tidak pernah hilang.
      urutkanBarisAnomaliDiDom(state.anomaliSort.kolom, state.anomaliSort.arah);
      perbaruiLabelHeaderAnomali();
    });
    trHead.appendChild(th);
    // Kolom "Kabupaten" ekstra di mode semua disisipkan TEPAT SETELAH
    // header "No" (bukan sebelumnya lagi) -- supaya "No" tetap kolom
    // paling kiri (setelah checkbox kalau ada), baru menyusul nama
    // Kabupaten, baru Kecamatan dst.
    if (modeSemua && key === "no_urut") {
      const thKab = document.createElement("th");
      thKab.className = "th-sortable col-kecamatan"; // pakai lebar kecamatan
      thKab.textContent = "Kabupaten";
      thKab.dataset.kolom = "_kab";
      thKab.addEventListener("click", () => {
        if (state.anomaliSort.kolom === "_kab") {
          state.anomaliSort.arah = state.anomaliSort.arah === "asc" ? "desc" : "asc";
        } else {
          state.anomaliSort = { kolom: "_kab", arah: "asc" };
        }
        urutkanBarisAnomaliDiDom(state.anomaliSort.kolom, state.anomaliSort.arah);
        perbaruiLabelHeaderAnomali();
      });
      trHead.appendChild(thKab);
    }
  });
  if (provFull) {
    const thLabel = document.createElement("th");
    thLabel.className = "col-label";
    thLabel.textContent = "Label";
    trHead.appendChild(thLabel);
  }
  if (provFull) {
    const thHapus = document.createElement("th");
    thHapus.className = "col-hapus";
    trHead.appendChild(thHapus);
  }
  thead.appendChild(trHead);
  tbl.appendChild(thead);
  const tbody = document.createElement("tbody");

  rows.forEach((r, idxBaris) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    // Simpan kab_id di row supaya bisa dibaca saat sort kolom Kabupaten
    tr.dataset.kabId = r.kab_id || "";

    // Mode "Semua Kabupaten/Kota": kolom No ditampilkan jalan terus
    // 1,2,3,... mengikuti urutan baris yang tampil -- BUKAN no_urut asli
    // dari database (yang direset per kabupaten jadi 1,1,1,1,...).
    const nilaiNo = modeSemua ? (idxBaris + 1) : (r.no_urut ?? "");
    const tdNo = editableTd(nilaiNo, "no_urut", prov && !modeSemua, true);
    tdNo.classList.add("col-no");

    const tdKecamatan = buatTdKecamatan(r.id, r.kecamatan ?? "", prov, state.daftarKecAktif);
    tdKecamatan.classList.add("col-kecamatan");

    const tdKomoditi = buatTdKomoditi(r.id, r.nama_komoditi ?? "", prov);
    tdKomoditi.classList.add("col-komoditi");

    const tdBulan = buatTdBulan(r.id, r.bulan, prov, jenisAktif);
    tdBulan.classList.add("td-bulan", "col-bulan");

    const tdKalimat = editableTd(r.kalimat_anomali ?? "", "kalimat_anomali", prov, false);
    tdKalimat.classList.add("col-anomali");

    const tdTindakLanjut = buatTdTindakLanjut(r.id, r.tindak_lanjut ?? "", !prov);
    tdTindakLanjut.classList.add("col-tindak-lanjut");

    const tdKabkot = editableTd(r.konfirmasi_kabkot ?? "", "konfirmasi_kabkot", !prov, false);
    tdKabkot.classList.add("col-kabkot");

    const tdApproval = document.createElement("td");
    tdApproval.classList.add("col-approval");
    if (prov) {
      const sel = document.createElement("select");
      sel.className = "sel-approval approval-" + (r.approval_provinsi || "kosong");
      sel.innerHTML = `
        <option value="" ${!r.approval_provinsi ? "selected" : ""}>Belum</option>
        <option value="ya" ${r.approval_provinsi === "ya" ? "selected" : ""}>Ya</option>
        <option value="tidak" ${r.approval_provinsi === "tidak" ? "selected" : ""}>Tidak</option>`;
      sel.addEventListener("change", async () => {
        sel.className = "sel-approval approval-" + (sel.value || "kosong");
        await simpanKolomAnomali(r.id, "approval_provinsi", sel.value);
      });
      tdApproval.appendChild(sel);
    } else {
      tdApproval.textContent = r.approval_provinsi === "ya" ? "Ya" : r.approval_provinsi === "tidak" ? "Tidak" : "Belum";
      tdApproval.classList.add("terkunci");
    }

    tr.appendChild(tdNo);
    tr.appendChild(tdKecamatan);
    tr.appendChild(tdKomoditi);
    tr.appendChild(tdBulan);
    tr.appendChild(tdKalimat);
    tr.appendChild(tdTindakLanjut);
    tr.appendChild(tdKabkot);
    tr.appendChild(tdApproval);

    if (provFull) {
      tr.appendChild(buatTdLabelSumber(r.sumber));
    }

    // Kolom Kabupaten (read-only) disisipkan TEPAT SETELAH sel "No"
    // (tdNo) -- bukan paling depan lagi -- supaya No tetap kolom paling
    // kiri (setelah checkbox kalau ada), baru menyusul nama Kabupaten.
    if (modeSemua) {
      const tdKabNama = document.createElement("td");
      tdKabNama.className = "col-kecamatan terkunci";
      const kabE = DAFTAR_KAB_BABEL.find((k) => k.id === r.kab_id);
      // "Kab. " sengaja dibuang dari kolom ini saja (bukan dari
      // DAFTAR_KAB_BABEL/dropdown Wilayah/dll) -- di tabel yang sudah
      // punya header "Kabupaten" sendiri, prefix itu jadi berlebihan
      // & bikin lebih makan tempat, cukup "Kota Pangkal Pinang" atau
      // "Bangka Tengah" saja.
      tdKabNama.textContent = kabE ? kabE.nama.replace(/^Kab\.\s+/i, "") : (r.kab_id || "");
      tr.insertBefore(tdKabNama, tdNo.nextSibling);
    }

    if (provFull) {
      const tdChk = document.createElement("td");
      tdChk.className = "col-chk";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "chk-anomali";
      chk.dataset.id = r.id;
      tdChk.appendChild(chk);
      tr.insertBefore(tdChk, tr.firstChild);
    }

    if (provFull) {
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
// (catatan: thead & tbody sengaja dirakit terpisah di atas -- thead pakai
// header sortable dgn event click, tbody isi baris data seperti biasa)

function editableTd(value, field, editable, isNumber) {
  const td = document.createElement("td");
  td.textContent = value;
  if (!editable) {
    td.classList.add("terkunci");
    return td;
  }
  td.contentEditable = "true";
  td.spellcheck = false; // matikan garis merah spellcheck bawaan browser
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
    // PENTING: cache lokal (state.anomaliRows) dipakai ulang oleh sort
    // (renderAnomaliSorted) TANPA fetch ulang ke DB -- kalau cache ini
    // tidak disinkronkan tiap kali ada edit, klik sort akan me-render
    // ulang dari data LAMA dan bikin isian yang baru diketik/dipilih
    // kelihatan "hilang" (balik ke nilai sebelum diedit).
    const row = state.anomaliRows.find((r) => r.id === id);
    if (row) row[field] = value;
  } catch (e) {
    alert("Gagal menyimpan: " + e.message);
  }
}

async function hapusBarisAnomali(id, trEl) {
  // Kasih indikator loading di tombol ✕ baris ini SENDIRI (bukan area
  // penuh) -- supaya user yang klik tahu prosesnya sedang jalan, tanpa
  // mengganggu baris lain yang mungkin lagi diedit.
  const btnHapus = trEl?.querySelector(".btn-hapus-baris");
  const chkBaris = trEl?.querySelector(".chk-anomali");
  if (btnHapus) {
    btnHapus.disabled = true;
    btnHapus.classList.add("loading");
    btnHapus.innerHTML = `<span class="mini-spinner"></span>`;
  }
  if (chkBaris) chkBaris.disabled = true;
  if (trEl) trEl.classList.add("baris-sedang-proses");

  try {
    const jenis = $("sel-jenis-anomali").value;
    // Mode semua: kab_id diambil dari dataset baris ybs, bukan dari dropdown
    const kabIdDropdown = $("sel-kab-anomali").value;
    const kabId = kabIdDropdown === "semua" ? (trEl?.dataset.kabId || "") : kabIdDropdown;

    const { error } = await supabase.from("konfirmasi_anomali").delete().eq("id", id);
    if (error) throw error;

    // Renomori ulang No baris yang tersisa biar urut rapi (1,2,3,...),
    // gak ada yang "bolong" bekas baris yang dihapus.
    if (kabId) {
      const sisa = await fetchAllRows((from, to) =>
        supabase
          .from("konfirmasi_anomali")
          .select("id, no_urut")
          .eq("jenis", jenis).eq("kab_id", kabId)
          .order("no_urut", { ascending: true })
          .range(from, to)
      );
      for (let i = 0; i < sisa.length; i++) {
        const nomorBaru = i + 1;
        if (sisa[i].no_urut !== nomorBaru) {
          await supabase.from("konfirmasi_anomali").update({ no_urut: nomorBaru }).eq("id", sisa[i].id);
        }
      }
    }

    await muatAnomali();
  } catch (e) {
    // Gagal -- kembalikan tombol ke kondisi semula supaya bisa dicoba lagi
    if (btnHapus) {
      btnHapus.disabled = false;
      btnHapus.classList.remove("loading");
      btnHapus.innerHTML = "✕";
    }
    if (chkBaris) chkBaris.disabled = false;
    if (trEl) trEl.classList.remove("baris-sedang-proses");
    alert("Gagal menghapus: " + e.message);
  }
}

// ---- Hapus Terpilih: hapus baris2 yg dicentang lewat checkbox di
// samping kolom No (cuma utk baris pada kombinasi jenis+kab yg SEDANG
// tampil, beda dgn "Hapus Semua Anomali" yg menghapus SEMUA data). ----
$("btn-hapus-terpilih-anomali")?.addEventListener("click", hapusTerpilihAnomali);

async function hapusTerpilihAnomali() {
  const checked = Array.from(document.querySelectorAll("#anomali-area .chk-anomali:checked"));
  if (checked.length === 0) {
    alert("Belum ada baris yang dipilih (centang dulu di kolom sebelah No).");
    return;
  }

  const ids = checked.map((c) => Number(c.dataset.id));
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;

  const btn = $("btn-hapus-terpilih-anomali");
  const teksAsli = btn.textContent;
  btn.disabled = true;
  btn.textContent = `⏳ Menghapus ${ids.length} baris...`;

  try {
    const { error } = await supabase.from("konfirmasi_anomali").delete().in("id", ids);
    if (error) throw error;

    // Renomori ulang No baris yang tersisa (kombinasi jenis+kab yg sama
    // dgn yg sedang tampil), biar tetap urut 1,2,3,... tanpa bolong.
    const sisa = await fetchAllRows((from, to) =>
      supabase
        .from("konfirmasi_anomali")
        .select("id, no_urut")
        .eq("jenis", jenis).eq("kab_id", kabId)
        .order("no_urut", { ascending: true })
        .range(from, to)
    );
    for (let i = 0; i < sisa.length; i++) {
      const nomorBaru = i + 1;
      if (sisa[i].no_urut !== nomorBaru) {
        await supabase.from("konfirmasi_anomali").update({ no_urut: nomorBaru }).eq("id", sisa[i].id);
      }
    }

    await muatAnomali(); // muatAnomali() merender ulang tabel -- tombol otomatis balik ke teks/normal
  } catch (e) {
    alert("Gagal menghapus baris terpilih: " + e.message);
    btn.disabled = false;
    btn.textContent = teksAsli;
  }
}

// ---- Tambah Baris: langsung insert baris baru pakai Triwulan & tahun
// berjalan sekarang (twSekarang()/TAHUN_SEKARANG), tanpa perlu popup lagi --
// kolom Periode sudah tidak ditampilkan di tabel, jadi gak perlu ditanya user. ----
$("btn-buka-tambah-anomali")?.addEventListener("click", async () => {
  const jenis = $("sel-jenis-anomali").value;
  const kabId = $("sel-kab-anomali").value;
  const periodeTeks = `TW${twSekarang()} ${TAHUN_SEKARANG}`;

  try {
    // PENTING: No urut baris baru WAJIB dihitung dari DATA ASLI di
    // database utk kombinasi jenis+kab yang sedang aktif -- BUKAN dari
    // jumlah <tr> yang kebetulan sedang tampil di #anomali-area. Kalau
    // yang lagi tampil di layar itu tabel Dashboard Anomali (bukan
    // daftar list), jumlah barisnya sama sekali tidak nyambung dgn
    // jenis+kab yg aktif (bisa gabungan banyak kab & jenis lain), jadi
    // no_urut yang dihasilkan jadi salah/meloncat (mis. jadi "10").
    const rowsSaatIni = await fetchAllRows((from, to) =>
      supabase.from("konfirmasi_anomali").select("id")
        .eq("jenis", jenis).eq("kab_id", kabId)
        .range(from, to)
    );
    const noUrutBaru = (rowsSaatIni?.length || 0) + 1;

    const { error } = await supabase.from("konfirmasi_anomali").insert({
      jenis, kab_id: kabId,
      no_urut: noUrutBaru,
      periode_teks: periodeTeks,
      kecamatan: "", nama_komoditi: "", kalimat_anomali: "", tindak_lanjut: "",
      sumber: "M",
    });
    if (error) throw error;
    // muatAnomali() otomatis balik menampilkan daftar list (bukan
    // Dashboard) -- supaya baris yang baru ditambah langsung kelihatan
    // & bisa langsung diisi.
    await muatAnomali();
  } catch (e) {
    alert("Gagal menambah baris: " + e.message);
  }
});

// ---- Popup Hapus Semua Anomali: SEKARANG benar2 GLOBAL -- menghapus
// SEMUA baris dari SEMUA jenis SPH & SEMUA kabupaten/kota sekaligus
// (bukan cuma kombinasi jenis+kab yg sedang difilter), sesuai maksud
// tombolnya. Jumlah yg ditampilkan di popup juga dihitung dari seluruh
// tabel, bukan cuma baris yg sedang tampil di layar. ----
async function bukaModalHapusAnomali() {
  let totalSemua = 0;
  try {
    const semua = await fetchAllRows((from, to) =>
      supabase.from("konfirmasi_anomali").select("id").range(from, to)
    );
    totalSemua = semua.length;
  } catch (e) {
    alert("Gagal mengecek jumlah data: " + e.message);
    return;
  }
  if (totalSemua === 0) {
    alert("Tidak ada data anomali sama sekali di seluruh kabupaten & jenis SPH.");
    return;
  }
  $("teks-konfirmasi-hapus-anomali").textContent =
    `Akan menghapus SEMUA ${totalSemua} baris data anomali dari SEMUA jenis SPH (SBS/BST/TBF/TH) ` +
    `dan SEMUA kabupaten/kota sekaligus. Tindakan ini tidak bisa dibatalkan.`;
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
  const btn = $("btn-konfirmasi-hapus-anomali");
  const teksAsli = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Menghapus semua...";
  $("btn-backup-lalu-hapus-anomali").disabled = true;
  $("btn-batal-hapus-anomali").disabled = true;
  try {
    // .not("id","is",null) = filter yang selalu cocok utk SEMUA baris
    // (setiap baris pasti punya id/primary key bukan null) -- dipakai
    // krn supabase-js mewajibkan minimal 1 filter utk perintah delete.
    const { error } = await supabase.from("konfirmasi_anomali").delete().not("id", "is", null);
    if (error) throw error;
    tutupModalHapusAnomali();
    await muatAnomali();
  } catch (e) {
    alert("Gagal menghapus semua data: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = teksAsli;
    $("btn-backup-lalu-hapus-anomali").disabled = false;
    $("btn-batal-hapus-anomali").disabled = false;
  }
}

$("btn-konfirmasi-hapus-anomali")?.addEventListener("click", hapusSemuaAnomali);

$("btn-backup-lalu-hapus-anomali")?.addEventListener("click", async () => {
  const btn = $("btn-backup-lalu-hapus-anomali");
  btn.disabled = true;
  btn.textContent = "⏳ Mengunduh backup...";
  try {
    // Backup sekarang mencakup SEMUA kab & SEMUA jenis SPH (bukan cuma
    // kombinasi yg sedang difilter), supaya sama cakupannya dgn yg akan
    // dihapus oleh "Hapus Semua Anomali".
    const berhasil = await downloadBackupSemuaAnomali();
    if (berhasil) {
      await hapusSemuaAnomali();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Download Backup Excel, lalu Hapus";
  }
});

// ============================================================
// GENERATE ANOMALI DARI OUTLIER (khusus prov PENUH / superadmin,
// misal sphbps19 -- disembunyikan utk sph1900 & kabkot lewat
// siapkanSlicerAnomali()).
// ============================================================
function bukaModalGenerateAnomali() {
  const kabId = $("sel-kab-anomali").value;
  if (kabId === "semua") {
    $("txt-kab-generate").textContent = "Semua Kabupaten/Kota";
  } else {
    const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabId);
    $("txt-kab-generate").textContent = kabEntry ? kabEntry.nama : kabId;
  }
  isiPilihanTahun($("sel-tahun-generate-anomali"));
  $("log-generate-anomali").textContent = "";
  $("modal-generate-anomali").classList.remove("hidden");
}
function tutupModalGenerateAnomali() {
  $("modal-generate-anomali").classList.add("hidden");
}
$("btn-buka-generate-anomali")?.addEventListener("click", bukaModalGenerateAnomali);
$("btn-tutup-generate-anomali")?.addEventListener("click", tutupModalGenerateAnomali);
$("modal-generate-anomali")?.addEventListener("click", (e) => {
  if (e.target.id === "modal-generate-anomali") tutupModalGenerateAnomali();
});

// Deteksi outlier per komoditi (pakai tab provitas utama -- tab pertama
// yang bukan tab "harga"/single), persis logic IQR yang dipakai tabel
// Rekonsiliasi (iqrBounds/isOutlier di atas), lalu insert baris anomali
// baru dgn sumber = "G" (Generated). Baris yang kombinasi
// kecamatan+komoditi+periode-nya SUDAH ADA (utk jenis+kab ini) dilewati,
// supaya tombol ini aman diklik berkali-kali tanpa bikin duplikat.
// Samakan ejaan nama kecamatan ke bentuk KANONIK yang sama dgn yang
// dipakai combobox manual (lihat muatKecamatanKab) -- supaya baris hasil
// Generate Anomali TIDAK punya ejaan kecamatan yang beda2 (mis.
// "MERAWANG" vs "Merawang") dibanding baris yang ditambah manual.
function keyKecamatan(n) {
  return normalisasiNamaTanaman(n).replace(/\s+/g, "");
}
function cariNamaKecKanonik(namaAsli, daftarKec) {
  const key = keyKecamatan(namaAsli);
  const cocok = (daftarKec || []).find((n) => keyKecamatan(n) === key);
  return cocok || namaAsli;
}

// Helper generate anomali utk 1 kabupaten tertentu (dipanggil baik mode
// single maupun mode "semua kabupaten/kota").
async function generateAnomaliUntukSatuKab(kabId, tahun, log) {
  const daftarKecKanonik = await muatKecamatanKab(kabId);
  const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabId);
  const labelKab = kabEntry ? kabEntry.nama : kabId;
  const ringkasan = [];
  let totalDitambah = 0;

  for (const jenis of JENIS_LIST_DASHBOARD) {
    log.textContent = `[${labelKab}] Memindai ${SPH_CONFIG[jenis].label}...`;

    const cfg = SPH_CONFIG[jenis];
    const tabUtama = cfg.tabs.find((t) => !t.single) || cfg.tabs[0];

    const rows = await fetchAllRows((from, to) =>
      supabase.from(cfg.table).select("*").eq("tahun", tahun).eq("nama_kab", kabId).range(from, to)
    );
    if (!rows || rows.length === 0) {
      ringkasan.push(`${labelKab} · ${cfg.label}: tidak ada data`);
      continue;
    }

    const existing = await fetchAllRows((from, to) =>
      supabase.from("konfirmasi_anomali").select("kecamatan, nama_komoditi, bulan")
        .eq("jenis", jenis).eq("kab_id", kabId).range(from, to)
    );
    const existSet = new Set(
      (existing || []).map((e) => `${normalisasiNamaTanaman(e.kecamatan)}|${normalisasiNamaTanaman(e.nama_komoditi)}|${e.bulan}`)
    );
    let noUrut = existing?.length || 0;

    const perKomoditi = new Map();
    for (const r of rows) {
      const nama = r.namatanaman;
      if (!nama) continue;
      if (!perKomoditi.has(nama)) perKomoditi.set(nama, []);
      perKomoditi.get(nama).push(r);
    }

    const periodeCol = cfg.periodeCol;
    const barisBaru = [];

    for (const [komoditi, rowsKom] of perKomoditi.entries()) {
      const matrix = new Map();
      const kecInfo = new Map();
      for (const r of rowsKom) {
        const per = Number(r[periodeCol]);
        matrix.set(`${r.kec}|${per}`, nilaiFromRow(r, tabUtama));
        if (!kecInfo.has(r.kec)) kecInfo.set(r.kec, r.nama_kec);
      }

      const [lo, hi] = iqrBounds(Array.from(matrix.values()));
      if (lo === null) continue;

      for (const [key, v] of matrix.entries()) {
        if (!isOutlier(v, lo, hi)) continue;
        const [kecKode, perStr] = key.split("|");
        const per = Number(perStr);
        const namaKecAsli = kecInfo.get(kecKode) || kecKode;
        const namaKec = cariNamaKecKanonik(namaKecAsli, daftarKecKanonik);

        const dupKey = `${normalisasiNamaTanaman(namaKec)}|${normalisasiNamaTanaman(komoditi)}|${per}`;
        if (existSet.has(dupKey)) continue;
        existSet.add(dupKey);

        noUrut += 1;
        const labelPeriode = periodeCol === "triwulan" ? `Tw${per}` : (cfg.periodeLabels[per - 1] || per);

        barisBaru.push({
          jenis, kab_id: kabId,
          no_urut: noUrut,
          periode_teks: `${labelPeriode} ${tahun}`,
          kecamatan: namaKec,
          nama_komoditi: komoditi,
          bulan: per,
          kalimat_anomali:
            `Nilai ${tabUtama.label} sebesar ${fmt(v, 2)} ${tabUtama.satuan} terdeteksi di luar ` +
            `rentang wajar (${fmt(lo, 2)} s.d. ${fmt(hi, 2)} ${tabUtama.satuan}).`,
          tindak_lanjut: "",
          sumber: "G",
        });
      }
    }

    if (barisBaru.length === 0) {
      ringkasan.push(`${labelKab} · ${cfg.label}: tidak ada outlier baru`);
      continue;
    }

    const { error } = await supabase.from("konfirmasi_anomali").insert(barisBaru);
    if (error) throw new Error(`${labelKab} · ${cfg.label}: ${error.message}`);

    totalDitambah += barisBaru.length;
    ringkasan.push(`${labelKab} · ${cfg.label}: ${barisBaru.length} baris baru`);
  }

  return { totalDitambah, ringkasan };
}

async function generateAnomaliDariOutlier() {
  const kabId = $("sel-kab-anomali").value;
  const tahun = Number($("sel-tahun-generate-anomali").value);
  const btn = $("btn-generate-anomali");
  const log = $("log-generate-anomali");
  const modeSemua = kabId === "semua";

  btn.disabled = true;
  btn.textContent = "⏳ Memproses...";

  const ringkasan = [];
  let totalDitambah = 0;

  try {
    const kabList = modeSemua ? KAB_ANOMALI_LIST : [kabId];

    for (const kab of kabList) {
      const hasil = await generateAnomaliUntukSatuKab(kab, tahun, log);
      totalDitambah += hasil.totalDitambah;
      ringkasan.push(...hasil.ringkasan);
    }

    log.textContent = totalDitambah > 0
      ? `✓ Selesai! ${totalDitambah} baris anomali ditambahkan.\n${ringkasan.join("\n")}`
      : `Tidak ada outlier baru yang ditemukan.\n${ringkasan.join("\n")}`;

    if (totalDitambah > 0) {
      setTimeout(() => tutupModalGenerateAnomali(), 1200);
      await muatAnomali(); // refresh tampilan list utk jenis+kab yg sedang aktif di dropdown
    }
  } catch (e) {
    log.textContent = `✗ Gagal: ${e.message}${ringkasan.length ? "\n" + ringkasan.join("\n") : ""}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Generate Anomali";
  }
}
$("btn-generate-anomali")?.addEventListener("click", generateAnomaliDariOutlier);

// ---- Upload Excel (khusus prov): boleh berisi 1 s.d. 4 tab sheet
// SEKALIGUS dalam satu file, satu tab per Jenis SPH -- nama tab
// dicocokkan ke label Jenis SPH ("SPH-SBS"/"SPH-BST"/"SPH-TBF"/"SPH-TH")
// ATAU singkatannya ("sbs"/"bst"/"tbf"/"th"), tidak peka besar/kecil
// huruf. Tab yang namanya tidak dikenali otomatis DILEWATI -- jadi kalau
// filenya cuma ada 1, 2, atau 3 tab yang valid, itu tetap jalan normal
// (tidak wajib 4 tab lengkap). Jenis SPH tiap baris DITENTUKAN DARI NAMA
// TAB-nya sendiri, BUKAN dari dropdown "Jenis SPH" yang sedang dipilih
// di layar -- kolom Periode, No, Nama Komoditi, Kalimat Anomali.
// Cocokkan label kabupaten (dari kolom "Kabupaten/Kota" di Excel, atau
// dari nama sheet) balik ke id kabupaten internal (mis. "Kab. Bangka"
// atau "Bangka" -> "Bangka"). Dipakai supaya Upload Excel bisa membaca
// kabupaten LANGSUNG DARI ISI FILE -- bukan cuma dari dropdown Wilayah
// yang sedang aktif di layar -- sehingga file hasil "Download Anomali
// SPH" baik dari mode 1 kabupaten MAUPUN mode "Semua Kabupaten/Kota"
// bisa diupload ulang tanpa peduli dropdown sedang di posisi mana.
function cariKabIdDariLabel(label) {
  const s = String(label ?? "").trim().toLowerCase();
  if (!s) return null;
  const entry = DAFTAR_KAB_BABEL.find(
    (k) => k.nama.toLowerCase() === s || k.id.toLowerCase() === s
  );
  return entry ? entry.id : null;
}

$("in-file-anomali")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  // kabDropdown dipakai HANYA sebagai fallback -- kalau baris di Excel
  // tidak punya kolom "Kabupaten/Kota" yang bisa dikenali (mis. file
  // free-form yang ditulis manual oleh user, bukan hasil Download
  // Anomali SPH), kabupaten baris itu diambil dari dropdown ini. Kalau
  // dropdown sedang "semua" DAN baris itu juga tidak punya info
  // kabupaten, baris itu terpaksa dilewati (dilaporkan di ringkasan).
  const kabDropdown = $("sel-kab-anomali").value;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });

    // key `${jenis}|${kabId}` -> array baris siap insert (no_urut belum diisi)
    const grupBaris = new Map();
    const sheetTakDikenali = [];
    let dilewatiTanpaKab = 0;

    for (const sheetName of wb.SheetNames) {
      const kunci = sheetName.trim().toLowerCase();
      let jenis = JENIS_LIST_DASHBOARD.find(
        (j) => SPH_CONFIG[j].label.toLowerCase() === kunci || j === kunci
      );
      // Nama sheet hasil download mode "Semua Kabupaten/Kota" berformat
      // "<Label SPH>_<NamaKab>" (mis. "SPH-SBS_Kab.Bangka") -- kalau
      // tidak cocok persis di atas, coba cocokkan bagian sebelum "_"
      // saja.
      if (!jenis) {
        const prefix = kunci.split("_")[0];
        jenis = JENIS_LIST_DASHBOARD.find(
          (j) => SPH_CONFIG[j].label.toLowerCase() === prefix || j === prefix
        );
      }
      if (!jenis) { sheetTakDikenali.push(sheetName); continue; }

      const rowsSheet = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
      const jenisAdalahBulan = jenis === "sbs";
      const daftarPeriodeSheet = daftarPeriodeAnomali(jenis);

      for (const row of rowsSheet) {
        // Kolom periode di Excel: "Bulan" utk SPH-SBS, "Triwulan" utk
        // SPH-BST/TBF/TH (fallback ke "Bulan" juga diterima kalau file
        // lama masih pakai nama kolom itu). Bisa berisi angka (1-12 atau
        // 1-4), nama bulan penuh ("Februari"), atau singkatan
        // ("Feb"/"Tw2") -- coba semuanya.
        const periodeRaw = String(
          (jenisAdalahBulan ? (row["Bulan"] ?? row.bulan) : (row["Triwulan"] ?? row.triwulan ?? row["Bulan"] ?? row.bulan)) ?? ""
        ).trim();
        const maxVal = jenisAdalahBulan ? 12 : 4;
        let bulanVal = null;
        if (periodeRaw !== "") {
          const angkaMurni = /^[0-9]+$/.test(periodeRaw) ? Number(periodeRaw) : NaN;
          if (!Number.isNaN(angkaMurni) && angkaMurni >= 1 && angkaMurni <= maxVal) {
            bulanVal = angkaMurni;
          } else if (jenisAdalahBulan) {
            const idxPenuh = NAMA_BULAN.findIndex((n) => n.toLowerCase() === periodeRaw.toLowerCase());
            const idxSingkat = daftarPeriodeSheet.findIndex((n) => n.toLowerCase() === periodeRaw.toLowerCase());
            if (idxPenuh > 0) bulanVal = idxPenuh; // NAMA_BULAN index 0 = "" (kosong), jadi index = nomor bulan
            else if (idxSingkat >= 0) bulanVal = idxSingkat + 1;
          } else {
            const idxSingkat = daftarPeriodeSheet.findIndex((n) => n.toLowerCase() === periodeRaw.toLowerCase());
            if (idxSingkat >= 0) {
              bulanVal = idxSingkat + 1;
            } else {
              // Fallback: teks campuran spt "Triwulan 2" -- ambil angka di dalamnya
              const angkaDalamTeks = Number((periodeRaw.match(/[0-9]+/) || [])[0]);
              if (!Number.isNaN(angkaDalamTeks) && angkaDalamTeks >= 1 && angkaDalamTeks <= maxVal) bulanVal = angkaDalamTeks;
            }
          }
        }
        const tindakRaw = String(row["Tindak Lanjut"] ?? row.tindak_lanjut ?? "").trim().toLowerCase();
        const tindakVal = tindakRaw === "wajar" ? "wajar" : tindakRaw === "perbaikan" ? "perbaikan" : "";

        const kecamatan = String(row["Kecamatan"] ?? row.kecamatan ?? "").trim();
        const namaKomoditi = String(row["Nama Komoditi"] ?? row.nama_komoditi ?? "").trim();
        const kalimatAnomali = String(row["Kalimat Anomali"] ?? row.kalimat_anomali ?? "").trim();
        if (!namaKomoditi && !kalimatAnomali) continue; // baris kosong -- lewati

        // Kabupaten baris ini: UTAMAKAN kolom "Kabupaten/Kota" di file
        // (kalau ada & dikenali) -- ini yang bikin file hasil download
        // "Semua Kabupaten/Kota" (per baris beda kabupaten) tetap benar
        // saat diupload ulang, terlepas dropdown Wilayah lagi di posisi
        // mana. Kalau kolom itu kosong/tidak dikenali, baru fallback ke
        // dropdown yang sedang dipilih (asalkan bukan "semua").
        const kabDariKolom = cariKabIdDariLabel(row["Kabupaten/Kota"] ?? row.kabupaten ?? "");
        const kabId = kabDariKolom || (kabDropdown !== "semua" ? kabDropdown : null);
        if (!kabId) { dilewatiTanpaKab++; continue; }

        const baris = {
          jenis, kab_id: kabId,
          kecamatan, bulan: bulanVal, nama_komoditi: namaKomoditi,
          kalimat_anomali: kalimatAnomali, tindak_lanjut: tindakVal,
          sumber: "M",
        };
        const key = `${jenis}|${kabId}`;
        if (!grupBaris.has(key)) grupBaris.set(key, []);
        grupBaris.get(key).push(baris);
      }
    }

    if (grupBaris.size === 0) {
      let pesan =
        "Tidak ada baris valid utk diupload.\n" +
        "Pastikan nama tab sheet sesuai Jenis SPH (SPH-SBS/SPH-BST/SPH-TBF/SPH-TH, " +
        "atau singkatannya sbs/bst/tbf/th), dan tiap baris ada isi Nama Komoditi / Kalimat Anomali.";
      if (dilewatiTanpaKab > 0) {
        pesan += `\n\n${dilewatiTanpaKab} baris dilewati karena kabupatennya tidak diketahui ` +
          `(kolom "Kabupaten/Kota" kosong/tidak dikenali, dan dropdown Wilayah sedang "Semua Kabupaten/Kota"). ` +
          `Pilih kabupaten spesifik di dropdown Wilayah dulu, atau pastikan kolom "Kabupaten/Kota" terisi benar.`;
      }
      alert(pesan);
      return;
    }

    // No urut baris baru disambung dari JUMLAH BARIS YANG SUDAH ADA di
    // database utk tiap kombinasi jenis+kab (bukan asal pakai kolom "No"
    // di Excel -- itu rawan bentrok/duplikat sama baris yang sudah ada).
    // Dikelompokkan per jenis+kab (bukan per jenis saja) karena satu
    // file sekarang bisa berisi baris dari BEBERAPA kabupaten sekaligus.
    let semuaBaris = [];
    const ringkasan = [];
    for (const [key, daftarBaris] of grupBaris.entries()) {
      const [jenis, kabIdGrup] = key.split("|");
      const rowsSaatIni = await fetchAllRows((from, to) =>
        supabase.from("konfirmasi_anomali").select("id")
          .eq("jenis", jenis).eq("kab_id", kabIdGrup)
          .range(from, to)
      );
      let noUrut = rowsSaatIni?.length || 0;
      const daftar = daftarBaris.map((r) => {
        noUrut += 1;
        return { ...r, no_urut: noUrut };
      });
      semuaBaris = semuaBaris.concat(daftar);
      const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabIdGrup);
      ringkasan.push(`${SPH_CONFIG[jenis].label} · ${kabEntry ? kabEntry.nama : kabIdGrup}: ${daftar.length} baris`);
    }

    const { error } = await supabase.from("konfirmasi_anomali").insert(semuaBaris);
    if (error) throw error;

    let pesan = `✓ Berhasil menambah ${semuaBaris.length} baris anomali.\n${ringkasan.join("\n")}`;
    if (sheetTakDikenali.length > 0) {
      pesan += `\n\nTab dilewati (nama tidak dikenali sbg Jenis SPH): ${sheetTakDikenali.join(", ")}`;
    }
    if (dilewatiTanpaKab > 0) {
      pesan += `\n\n${dilewatiTanpaKab} baris dilewati karena kabupatennya tidak diketahui.`;
    }
    alert(pesan);

    await muatAnomali();
  } catch (err) {
    alert("Gagal upload Excel: " + err.message);
  } finally {
    e.target.value = "";
  }
});

// ---- Download Excel (prov & kabkot): SEMUA jenis SPH utk kabupaten yang
// SEDANG DIPILIH di dropdown "sel-kab-anomali", masing2 jenis jadi tab
// sheet sendiri (SBS/BST/TBF/TH) -- jadi 1x klik langsung dapat semuanya,
// gak perlu gonta-ganti dropdown Jenis SPH & download berkali-kali. ----
$("btn-download-anomali")?.addEventListener("click", downloadAnomaliExcel);
$("btn-download-anomali-kabkot")?.addEventListener("click", downloadAnomaliExcel);

// Kolom "ID" WAJIB ada di posisi pertama -- ini id unik (primary key) dari
// database, dipakai sebagai kunci pencocokan saat kabkot mengupload balik
// file ini utk mengisi "Konfirmasi Kabkot" (lihat uploadKonfirmasiKabkot()).
// JANGAN diubah/dihapus user, dan JANGAN dipakai utk baris baru yang
// ditambah manual di Excel (baris tanpa ID otomatis dilewati saat upload).
const ANOMALI_HEADERS = ["ID", "No", "Kabupaten/Kota", "Kecamatan", "Bulan", "Nama Komoditi", "Kalimat Anomali", "Tindak Lanjut", "Konfirmasi Kabkot", "Approval Provinsi"];
const ANOMALI_COL_WIDTHS = [{ wch: 8 }, { wch: 6 }, { wch: 22 }, { wch: 18 }, { wch: 12 }, { wch: 24 }, { wch: 40 }, { wch: 14 }, { wch: 30 }, { wch: 16 }];

// Helper: tulis 1 sheet Anomali dari array rows (dipakai baik utk
// download per-kab-semua-SPH maupun backup-semua-data-global).
function tulisSheetAnomaliDariRows(wb, sheetName, rows, jenis) {
  const ws = {};
  const headers = [...ANOMALI_HEADERS];
  headers[4] = labelKolomPeriodeAnomali(jenis); // "Bulan" (SBS) atau "Triwulan" (BST/TBF/TH)
  const range = { s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } };
  const setCell = (r, c, cell) => { ws[XLSX.utils.encode_cell({ r, c })] = cell; };

  headers.forEach((h, c) => setCell(0, c, xlCell(h, { bold: true, bgColor: XL_HIJAU_HEADER, color: XL_PUTIH, align: "left" })));
  const daftarPeriode = daftarPeriodeAnomali(jenis);
  const labelTindak = (v) => (v === "wajar" ? "Wajar" : v === "perbaikan" ? "Perbaikan" : "");
  rows.forEach((r, i) => {
    const stripeBg = i % 2 === 1 ? XL_ABU_STRIPE : undefined;
    const bulanLabel = r.bulan ? (daftarPeriode[r.bulan - 1] || r.bulan) : "";
    const kabEntryRow = DAFTAR_KAB_BABEL.find((k) => k.id === r.kab_id);
    const labelKabRow = kabEntryRow ? kabEntryRow.nama : (r.kab_id || "");
    const vals = [
      r.id, r.no_urut, labelKabRow, r.kecamatan || "", bulanLabel, r.nama_komoditi, r.kalimat_anomali,
      labelTindak(r.tindak_lanjut), r.konfirmasi_kabkot,
      r.approval_provinsi === "ya" ? "Ya" : r.approval_provinsi === "tidak" ? "Tidak" : "",
    ];
    vals.forEach((v, c) => setCell(i + 1, c, xlCell(v, { align: c <= 1 ? "center" : "left", bgColor: stripeBg })));
  });

  ws["!ref"] = XLSX.utils.encode_range(range);
  ws["!cols"] = ANOMALI_COL_WIDTHS;
  // Nama sheet Excel maks 31 karakter & tidak boleh mengandung : \ / ? * [ ]
  const namaAman = sheetName.replace(/[:\\/?*[\]]/g, "").slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, namaAman);
}

async function downloadAnomaliExcel() {
  const kabId = $("sel-kab-anomali").value;
  const modeSemua = kabId === "semua";
  const kabList = modeSemua ? KAB_ANOMALI_LIST : [kabId];
  const labelKabFile = modeSemua ? "SemuaKab" : (DAFTAR_KAB_BABEL.find((k) => k.id === kabId)?.nama || kabId).replace(/\s+/g, "");

  const wb = XLSX.utils.book_new();
  let adaData = false;

  try {
    for (const kab of kabList) {
      for (const jenis of JENIS_LIST_DASHBOARD) {
        const rows = await fetchAllRows((from, to) =>
          supabase.from("konfirmasi_anomali").select("*")
            .eq("jenis", jenis).eq("kab_id", kab)
            .order("no_urut", { ascending: true }).range(from, to)
        );
        if (!rows || rows.length === 0) continue;
        adaData = true;
        // Mode semua: nama sheet "SPH-SBS_Kab. Bangka" dst agar tiap kab+jenis beda tab
        // Mode single: nama sheet cukup "SPH-SBS" dst (sama seperti sebelumnya)
        const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kab);
        const sheetName = modeSemua
          ? `${SPH_CONFIG[jenis].label}_${(kabEntry?.nama || kab).replace(/\s+/g, "")}`
          : SPH_CONFIG[jenis].label;
        tulisSheetAnomaliDariRows(wb, sheetName, rows, jenis);
      }
    }
  } catch (e) {
    alert("Gagal mengambil data: " + e.message);
    return false;
  }

  if (!adaData) {
    alert("Tidak ada data anomali untuk didownload.");
    return false;
  }

  XLSX.writeFile(wb, `KonfirmasiAnomali_${labelKabFile}.xlsx`, { cellStyles: true });
  return true;
}

// ---- Upload Konfirmasi Excel (khusus kabkot): kebalikan dari download
// di atas -- kabkot boleh kerja offline dulu di file "KonfirmasiAnomali_
// ....xlsx" hasil download (isi kolom "Konfirmasi Kabkot" per tab sheet
// jenis SPH: SPH-SBS/SPH-BST/SPH-TBF/SPH-TH), lalu upload balik file
// yang sama di sini.
//
// Pencocokan baris PAKAI KOLOM "ID" (bukan posisi baris / No / nama
// komoditi) -- ID ini id asli dari database yang sudah tertulis otomatis
// tiap baris saat didownload (lihat tulisSheetAnomaliDariRows). Ini
// supaya:
//  - Baris tidak pernah "kepasang" ke anomali lain gara2 urutan Excel
//    beda/ke-sort/ada baris disisipkan manual.
//  - Kalau ternyata Provinsi SUDAH MENGHAPUS anomali itu duluan sebelum
//    kabkot sempat upload, ID-nya otomatis tidak ketemu lagi di database
//    -- baris itu dilewati begitu saja (aman, tidak nyasar mengisi
//    konfirmasi ke anomali lain), dan dilaporkan di ringkasan akhir.
// Baris yang ditambah manual di Excel tanpa isi kolom ID (mis. kabkot
// nulis baris baru sendiri) juga otomatis dilewati -- fitur ini cuma
// utk MENGISI KONFIRMASI baris yang sudah ada, bukan menambah baris baru
// (utk itu tetap lewat tombol "+ Tambah Baris" / upload Provinsi).
async function uploadKonfirmasiKabkotExcel(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });

    let totalDicoba = 0, diupdate = 0, dilewati = 0;

    for (const sheetName of wb.SheetNames) {
      // Cocokkan nama tab sheet ke jenis SPH -- terima baik nama tab
      // persis label ("SPH-SBS") maupun singkat ("sbs", tidak peka
      // besar/kecil huruf), supaya tetap jalan walau tabnya sempat
      // diganti nama oleh user.
      const kunciSheet = sheetName.trim().toLowerCase();
      const jenis = JENIS_LIST_DASHBOARD.find(
        (j) => SPH_CONFIG[j].label.toLowerCase() === kunciSheet || j === kunciSheet
      );
      if (!jenis) continue; // tab tidak dikenali -> lewati, bukan tab SPH

      const rowsSheet = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
      for (const row of rowsSheet) {
        const idRaw = row["ID"] ?? row["Id"] ?? row.id ?? "";
        const id = Number(idRaw);
        if (!idRaw || Number.isNaN(id)) continue; // baris tanpa ID (baris baru manual) -> lewati

        totalDicoba++;
        const konfirmasiBaru = String(row["Konfirmasi Kabkot"] ?? "").trim();

        const { data, error } = await supabase
          .from("konfirmasi_anomali")
          .update({ konfirmasi_kabkot: konfirmasiBaru })
          .eq("id", id)
          .select("id");

        if (error || !data || data.length === 0) {
          dilewati++; // ID tidak ketemu (kemungkinan sudah dihapus Provinsi) atau gagal
          continue;
        }
        diupdate++;
      }
    }

    if (totalDicoba === 0) {
      alert(
        "Tidak ada baris dengan kolom ID yang bisa diproses.\n" +
        "Pastikan file yang diupload adalah hasil download dari tombol " +
        "\"Download Excel (Semua SPH)\" (kolom ID jangan dihapus/diubah)."
      );
      return;
    }

    let pesan = `✓ Upload konfirmasi selesai.\n${diupdate} baris berhasil diupdate.`;
    if (dilewati > 0) {
      pesan += `\n${dilewati} baris dilewati (kemungkinan anomali itu sudah dihapus Provinsi, jadi diabaikan -- tidak perlu dimasukkan lagi).`;
    }
    alert(pesan);

    await muatAnomali();
  } catch (err) {
    alert("Gagal upload Excel: " + err.message);
  } finally {
    e.target.value = "";
  }
}
$("in-file-konfirmasi-kabkot")?.addEventListener("change", uploadKonfirmasiKabkotExcel);

// ---- Backup Global (dipakai sebelum "Hapus Semua Anomali"): mengambil
// SEMUA baris dari SEMUA jenis SPH & SEMUA kabupaten sekaligus, dikelompokkan
// jadi 1 sheet per kombinasi jenis+kab (mis. "SPH-SBS_Kab. Bangka"). ----
async function downloadBackupSemuaAnomali() {
  let rows;
  try {
    rows = await fetchAllRows((from, to) =>
      supabase.from("konfirmasi_anomali").select("*")
        .order("jenis", { ascending: true })
        .order("kab_id", { ascending: true })
        .order("no_urut", { ascending: true })
        .range(from, to)
    );
  } catch (e) {
    alert("Gagal mengambil data: " + e.message);
    return false;
  }
  if (!rows || rows.length === 0) {
    alert("Tidak ada data untuk didownload.");
    return false;
  }

  const grup = new Map(); // key `${jenis}|${kab_id}` -> rows[]
  for (const r of rows) {
    const key = `${r.jenis}|${r.kab_id}`;
    if (!grup.has(key)) grup.set(key, []);
    grup.get(key).push(r);
  }

  const wb = XLSX.utils.book_new();
  for (const [key, groupRows] of grup.entries()) {
    const [jenis, kabId] = key.split("|");
    const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kabId);
    const labelKab = kabEntry ? kabEntry.nama : kabId;
    const sheetLabel = (SPH_CONFIG[jenis]?.label || jenis.toUpperCase()) + "_" + labelKab;
    tulisSheetAnomaliDariRows(wb, sheetLabel, groupRows, jenis);
  }

  const tanggal = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `Backup_Semua_Anomali_${tanggal}.xlsx`, { cellStyles: true });
  return true;
}

// ============================================================
// DASHBOARD ANOMALI — ringkasan semua Jenis SPH x Kabupaten
// Tampil INLINE menggantikan tabel list Konfirmasi Anomali (bukan
// popup), dengan tombol "Kembali" utk balik ke tampilan list biasa.
// ============================================================
const JENIS_LIST_DASHBOARD = ["sbs", "bst", "tbf", "th"];

// Tombol "Dashboard Anomali" & "Kembali ke Daftar Anomali" sekarang jadi
// SATU tombol yang sama (bukan tombol terpisah lagi) -- teks & warnanya
// berubah tergantung lagi di tampilan mana (list biasa vs dashboard).
function perbaruiTombolDashboardAnomali() {
  const aktif = !!state.dashboardAnomaliAktif;
  document.querySelectorAll("#btn-buka-dashboard-anomali, #btn-buka-dashboard-anomali-kabkot").forEach((btn) => {
    btn.textContent = aktif ? "← Kembali ke Daftar Anomali" : "📊 Dashboard Anomali";
    btn.classList.toggle("btn-oranye", aktif);
  });
}

async function toggleDashboardAnomali() {
  if (state.dashboardAnomaliAktif) {
    await muatAnomali(); // muatAnomali() sendiri yg reset state & tombol
  } else {
    await bukaDashboardAnomali();
  }
}

$("btn-buka-dashboard-anomali")?.addEventListener("click", toggleDashboardAnomali);
$("btn-buka-dashboard-anomali-kabkot")?.addEventListener("click", toggleDashboardAnomali);

async function bukaDashboardAnomali() {
  const area = $("anomali-area");
  mulaiLoadingDonut(area, "Memuat data dashboard...");

  // Provinsi: lihat semua kab. Kabkot: cuma kabupatennya sendiri.
  const kabList = isProv() ? KAB_ANOMALI_LIST : [state.profile.kab_id];

  let rows;
  try {
    rows = await fetchAllRows((from, to) => {
      let q = supabase
        .from("konfirmasi_anomali")
        .select("jenis, kab_id, konfirmasi_kabkot, approval_provinsi");
      if (!isProv()) q = q.eq("kab_id", state.profile.kab_id);
      return q.range(from, to);
    });
  } catch (e) {
    area.innerHTML = `<div class="placeholder-kosong">Gagal memuat data: ${e.message}</div>`;
    return;
  }

  state.dashboardAnomaliAktif = true;
  perbaruiTombolDashboardAnomali();
  renderDashboardAnomali(rows, kabList);
}

// Format "count (pct%)" -- ditulis SATU BARIS (persen di dalam kurung
// di samping angka, bukan di baris bawahnya) supaya baris tabel lebih
// ngepas/rapat. Kalau total 0, persentase ditampilkan "-" supaya tidak
// muncul NaN%.
function fmtCountPct(count, total) {
  const pctVal = total > 0 ? Math.round((count / total) * 100) : 0;
  const warna = pctVal >= 100 ? "color:var(--hijau-muda);" : "color:var(--merah);";
  return `${count}<span class="pct" style="${warna}">(${pctVal}%)</span>`;
}

function renderDashboardAnomali(rows, kabList) {
  const area = $("anomali-area");

  const map = new Map(); // key `${kab}|${jenis}` -> stats
  for (const kab of kabList) {
    for (const jenis of JENIS_LIST_DASHBOARD) {
      map.set(`${kab}|${jenis}`, {
        total: 0, sudahKonfirmasi: 0, belumKonfirmasi: 0,
        approvalYa: 0, approvalTidak: 0, approvalBelum: 0,
      });
    }
  }

  for (const r of rows) {
    const key = `${r.kab_id}|${r.jenis}`;
    if (!map.has(key)) continue;
    const s = map.get(key);
    s.total++;
    const sudah = r.konfirmasi_kabkot && String(r.konfirmasi_kabkot).trim() !== "";
    if (sudah) s.sudahKonfirmasi++; else s.belumKonfirmasi++;
    if (r.approval_provinsi === "ya") s.approvalYa++;
    else if (r.approval_provinsi === "tidak") s.approvalTidak++;
    else s.approvalBelum++;
  }

  const totalRow = { total: 0, sudahKonfirmasi: 0, belumKonfirmasi: 0, approvalYa: 0, approvalTidak: 0, approvalBelum: 0 };

  // ---- Susun baris per kab (kumpulkan dulu semua baris jenis yg
  // datanya > 0, supaya tahu berapa rowspan utk sel Kabupaten) ----
  let bodyRows = "";
  let grupKeIdx = 0; // dinaikkan tiap pindah ke kabupaten baru -- dipakai utk selang-seling warna PER KELOMPOK kab (bukan per baris), biar batas antar kabupaten kelihatan jelas

  for (const kab of kabList) {
    const kabEntry = DAFTAR_KAB_BABEL.find((k) => k.id === kab);
    const labelKab = kabEntry ? kabEntry.nama : kab;

    const jenisTerisi = JENIS_LIST_DASHBOARD.filter((jenis) => map.get(`${kab}|${jenis}`).total > 0);
    if (jenisTerisi.length === 0) continue; // kab ini belum ada anomali sama sekali di semua SPH

    const clsGrup = grupKeIdx % 2 === 1 ? " grup-abu" : "";
    grupKeIdx++;

    // Akumulator subtotal KHUSUS kabupaten ini (direset tiap ganti kab),
    // supaya ada baris "Subtotal <Nama Kab>" di bawah baris2 SPH-nya --
    // sebelumnya cuma ada 1 baris TOTAL provinsi di paling bawah.
    const subTotalKab = { total: 0, sudahKonfirmasi: 0, belumKonfirmasi: 0, approvalYa: 0, approvalTidak: 0, approvalBelum: 0 };

    jenisTerisi.forEach((jenis, idx) => {
      const s = map.get(`${kab}|${jenis}`);

      totalRow.total += s.total;
      totalRow.sudahKonfirmasi += s.sudahKonfirmasi;
      totalRow.belumKonfirmasi += s.belumKonfirmasi;
      totalRow.approvalYa += s.approvalYa;
      totalRow.approvalTidak += s.approvalTidak;
      totalRow.approvalBelum += s.approvalBelum;

      subTotalKab.total += s.total;
      subTotalKab.sudahKonfirmasi += s.sudahKonfirmasi;
      subTotalKab.belumKonfirmasi += s.belumKonfirmasi;
      subTotalKab.approvalYa += s.approvalYa;
      subTotalKab.approvalTidak += s.approvalTidak;
      subTotalKab.approvalBelum += s.approvalBelum;

      // Sel Kabupaten cuma dicetak di baris pertama kab ini, dgn
      // rowspan sepanjang jumlah baris SPH yang terisi utk kab tsb
      // (mail-merge) -- baris berikutnya tidak perlu <td> kab lagi.
      const tdKab = idx === 0
        ? `<td class="nama" rowspan="${jenisTerisi.length}">${labelKab}</td>`
        : "";

      // "baris-mulai-kab" dikasih ke baris PERTAMA tiap kabupaten --
      // dipakai buat garis atas lebih tebal, jadi batas antar kabupaten
      // kelihatan tegas walau warnanya kebetulan sama (kab ganjil vs
      // ganjil berikutnya).
      const clsMulai = idx === 0 ? " baris-mulai-kab" : "";

      bodyRows += `<tr class="${clsGrup}${clsMulai}">
        ${tdKab}
        <td class="sph-cell">${SPH_CONFIG[jenis].label}</td>
        <td>${s.total}</td>
        <td>${fmtCountPct(s.sudahKonfirmasi, s.total)}</td>
        <td>${s.belumKonfirmasi}</td>
        <td>${s.approvalYa}</td>
        <td>${s.approvalTidak}</td>
        <td>${s.approvalBelum}</td>
      </tr>`;
    });

    // Baris Subtotal per kabupaten -- cuma ditampilkan kalau kab ini
    // punya lebih dari 1 jenis SPH terisi (kalau cuma 1 jenis, subtotal
    // = sama persis dgn baris SPH itu, jadi tidak perlu diulang).
    if (jenisTerisi.length > 1) {
      bodyRows += `<tr class="${clsGrup} baris-subtotal-kab">
        <td colspan="2">Subtotal ${labelKab}</td>
        <td>${subTotalKab.total}</td>
        <td>${fmtCountPct(subTotalKab.sudahKonfirmasi, subTotalKab.total)}</td>
        <td>${subTotalKab.belumKonfirmasi}</td>
        <td>${subTotalKab.approvalYa}</td>
        <td>${subTotalKab.approvalTidak}</td>
        <td>${subTotalKab.approvalBelum}</td>
      </tr>`;
    }
  }

  const headerDashboard = `
    <div class="dashboard-anomali-header">
      <h3>📊 Dashboard Anomali — Semua Jenis SPH</h3>
    </div>`;

  if (bodyRows === "") {
    area.innerHTML = headerDashboard + `<div class="placeholder-kosong">Belum ada data anomali sama sekali.</div>`;
    return;
  }

  area.innerHTML = `
    ${headerDashboard}
    <div class="dashboard-anomali-scroll">
      <table class="tabel-dashboard-anomali">
        <thead>
          <tr>
            <th>Kabupaten</th><th>SPH</th><th>Total Anomali</th>
            <th>Sudah Konfirmasi</th><th>Belum Konfirmasi</th>
            <th>Approval: Ya</th><th>Approval: Tidak</th><th>Approval: Belum</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
          <tr class="baris-total-dashboard">
            <td colspan="2">TOTAL</td>
            <td>${totalRow.total}</td>
            <td>${fmtCountPct(totalRow.sudahKonfirmasi, totalRow.total)}</td>
            <td>${totalRow.belumKonfirmasi}</td>
            <td>${totalRow.approvalYa}</td>
            <td>${totalRow.approvalTidak}</td>
            <td>${totalRow.approvalBelum}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================
// Mulai
// ============================================================
cekSesiAwal();
