// sph-config.js
// Mirror dari logic fitur_rekon.py: struktur kolom & tab provitas/harga
// beda-beda per jenis SPH. Dipakai panel Rekon utk tahu kolom mana yang
// jadi pembilang/penyebut provitas, dan tab apa saja yang tersedia.
//
// `excelCols` = mapping nama kolom di tabel Supabase -> nama kolom di
// file Excel hasil "Download Data". Nama kolom Excel ini SENGAJA dibuat
// mengandung kata kunci yang SAMA seperti yang dicari fitur_rekon.py di
// aplikasi desktop (mis. "Luas panen habis", "Produksi Habis", "Harga
// jual petani", dst) supaya file Excel yang didownload dari web ini bisa
// LANGSUNG dipakai di menu "3. Rekonsiliasi" -> "Pilih File Raw" di
// aplikasi desktop untuk membuat Excel rekon dinamis (dengan dropdown).

export const SPH_CONFIG = {
  sbs: {
    label: "SPH-SBS",
    table: "data_sbs",
    periodeCol: "bulan",
    periodeLabels: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
    judulPeriode: "Bulan",
    tabs: [
      { key: "provitas_habis", label: "Provitas Habis", satuan: "Kw/Ha",
        // PENTING (fix bug 100x): data mentah di DB satuannya Kg & M2,
        // tapi provitas harus Kuintal/Ha. (Kg/100) / (M2/10000) = Kg/M2 * 100
        // -> numerFactor 100 di formula numer*factor/denom.
        numer: "produksi_habis", denom: "luas_panen_habis", numerFactor: 100,
        rawNumer: { label: "Produksi Habis", satuan: "Kuintal", factor: 0.01 },
        rawDenom: { label: "Luas Panen Habis", satuan: "Ha", factor: 0.0001 } },
      { key: "provitas_belum", label: "Provitas Belum Habis", satuan: "Kw/Ha",
        numer: "produksi_belum_habis", denom: "luas_panen_belum_habis", numerFactor: 100,
        rawNumer: { label: "Produksi Belum Habis", satuan: "Kuintal", factor: 0.01 },
        rawDenom: { label: "Luas Panen Belum Habis", satuan: "Ha", factor: 0.0001 } },
      { key: "harga", label: "Harga Jual Petani", satuan: "Rp/Kg", single: "harga_jual_petani" },
    ],
    excelCols: {
      luas_awal_laporan:      "Luas awal laporan (M2)",
      luas_panen_habis:       "Luas panen habis (M2)",
      luas_panen_belum_habis: "Luas panen belum habis (M2)",
      luas_rusak:             "Luas rusak (M2)",
      luas_tanam:             "Luas tanam (M2)",
      luas_tanaman_akhir:     "Luas tanaman akhir (M2)",
      produksi_habis:         "Produksi Habis (Kg)",
      produksi_belum_habis:   "Produksi belum habis (Kg)",
      harga_jual_petani:      "Harga jual petani (Rp/kg)",
    },
  },
  tbf: {
    label: "SPH-TBF",
    table: "data_tbf",
    periodeCol: "triwulan",
    periodeLabels: ["1", "2", "3", "4"],
    judulPeriode: "Triwulan",
    tabs: [
      { key: "provitas_habis", label: "Provitas Habis", satuan: "Kw/Ha",
        numer: "produksi_habis", denom: "luas_panen_habis", numerFactor: 100,
        rawNumer: { label: "Produksi Habis", satuan: "Kuintal", factor: 0.01 },
        rawDenom: { label: "Luas Panen Habis", satuan: "Ha", factor: 0.0001 } },
      { key: "provitas_belum", label: "Provitas Belum Habis", satuan: "Kw/Ha",
        numer: "produksi_belum_habis", denom: "luas_panen_belum_habis", numerFactor: 100,
        rawNumer: { label: "Produksi Belum Habis", satuan: "Kuintal", factor: 0.01 },
        rawDenom: { label: "Luas Panen Belum Habis", satuan: "Ha", factor: 0.0001 } },
      { key: "harga", label: "Harga Jual Petani", satuan: "Rp/Kg", single: "harga_jual_petani" },
    ],
    excelCols: {
      luas_awal_laporan:      "Luas awal laporan (M2)",
      luas_panen_habis:       "Luas panen habis (M2)",
      luas_panen_belum_habis: "Luas panen belum habis (M2)",
      luas_rusak:             "Luas rusak (M2)",
      luas_tanam:             "Luas tanam (M2)",
      luas_tanaman_akhir:     "Luas tanaman akhir (M2)",
      produksi_habis:         "Produksi Habis (Kg)",
      produksi_belum_habis:   "Produksi belum habis (Kg)",
      harga_jual_petani:      "Harga jual petani (Rp/kg)",
    },
  },
  th: {
    label: "SPH-TH",
    table: "data_th",
    periodeCol: "triwulan",
    periodeLabels: ["1", "2", "3", "4"],
    judulPeriode: "Triwulan",
    tabs: [
      { key: "provitas_habis", label: "Provitas Habis", satuan: "Kw/Ha",
        numer: "produksi_habis", denom: "luas_panen_habis", numerFactor: 100,
        rawNumer: { label: "Produksi Habis", satuan: "Kuintal", factor: 0.01 },
        rawDenom: { label: "Luas Panen Habis", satuan: "Ha", factor: 0.0001 } },
      { key: "harga", label: "Harga Jual Petani", satuan: "Rp/Kg", single: "harga_jual_petani" },
    ],
    // TH tidak punya "belum habis", tapi kolomnya tetap disertakan di
    // Excel (fitur_rekon.py tidak masalah kalau kolom "belum" ikut ada --
    // label_jenis="th" yang menentukan tab mana yang ditampilkan, bukan
    // ada/tidaknya kolom di file).
    excelCols: {
      luas_awal_laporan:  "Luas awal laporan (M2)",
      luas_panen_habis:   "Luas panen habis (M2)",
      luas_rusak:         "Luas rusak (M2)",
      luas_tanam:         "Luas tanam (M2)",
      luas_tanaman_akhir: "Luas tanaman akhir (M2)",
      produksi_habis:     "Produksi Habis (Kg)",
      harga_jual_petani:  "Harga jual petani (Rp/kg)",
    },
  },
  bst: {
    label: "SPH-BST",
    table: "data_bst",
    periodeCol: "triwulan",
    periodeLabels: ["1", "2", "3", "4"],
    judulPeriode: "Triwulan",
    tabs: [
      { key: "provitas", label: "Provitas", satuan: "Kg/Pohon",
        numer: "produksi", numerFactor: 100, denom: "tanaman_produktif_hasil",
        rawNumer: { label: "Produksi", satuan: "Kuintal", factor: 1 },
        rawDenom: { label: "Tanaman Produktif yang Menghasilkan", satuan: "Pohon/Rumpun", factor: 1 } },
      { key: "harga", label: "Harga Jual Petani", satuan: "Rp/Kg", single: "harga_jual_petani" },
    ],
    excelCols: {
      jml_tanaman_awal_tw:     "Jumlah tanaman akhir triwulan yang lalu (pohon/rumpun)",
      tanaman_dibongkar:       "Tanaman yang dibongkar/ditebang (pohon/rumpun)",
      tanaman_baru:            "Tanaman baru/penanaman baru (pohon/rumpun)",
      // PENTING: nama kolom ini WAJIB mengandung persis
      // "Jumlah tanaman akhir triwulan laporan" -- itu penanda yang
      // dipakai fitur_rekon.py di desktop utk mendeteksi file sebagai
      // SPH-BST (lihat _HINT_JTA di fitur_rekon.py).
      jml_tanaman_akhir_tw:    "Jumlah tanaman akhir triwulan laporan (pohon/rumpun)",
      tanaman_belum_hasil:     "Tanaman belum menghasilkan (pohon/rumpun)",
      // PENTING: harus mengandung persis "Tanaman produktif yang
      // menghasilkan" (dipakai sbg penyebut provitas BST di desktop).
      tanaman_produktif_hasil: "Tanaman produktif yang menghasilkan (pohon/rumpun)",
      tanaman_tua_rusak:       "Tanaman tua/rusak (pohon/rumpun)",
      produksi:                "Produksi (Kuintal)",
      harga_jual_petani:       "Harga jual petani (Rp/kg)",
    },
  },
};

// PENTING: "id" di sini WAJIB sama persis (termasuk kapitalisasi & spasi)
// dengan isi kolom "nama_kab" di database Supabase, karena app.js
// memfilter data pakai .eq("nama_kab", id) -- bukan pakai kode kabupaten.
// Yang sudah dikonfirmasi lewat SQL: kab "01" -> nama_kab "Bangka".
// 6 baris lainnya MASIH TEBAKAN pola yang sama (tanpa "Kab."/"Kota").
// Begitu data kabupaten lain mulai tersinkron dari aplikasi desktop,
// jalankan ulang query berikut di Supabase SQL Editor untuk memastikan:
//   select distinct kab, nama_kab from data_sbs order by kab;
// lalu cocokkan/perbaiki nilai "id" di bawah ini kalau ternyata beda.
export const DAFTAR_KAB_BABEL = [
  { id: "Bangka", nama: "Kab. Bangka" },
  { id: "Belitung", nama: "Kab. Belitung" },
  { id: "Bangka Barat", nama: "Kab. Bangka Barat" },
  { id: "Bangka Tengah", nama: "Kab. Bangka Tengah" },
  { id: "Bangka Selatan", nama: "Kab. Bangka Selatan" },
  { id: "Belitung Timur", nama: "Kab. Belitung Timur" },
  { id: "Pangkal Pinang", nama: "Kota Pangkal Pinang" },
];
