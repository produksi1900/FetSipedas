# FetSipedas Web

Web ini **hanya membaca data dari database (Supabase)**. Sinkronisasi data
dari web sipedas.pertanian.go.id yang asli dilakukan lewat **aplikasi
desktop FetSipedas**, bukan lewat web ini — jadi web ini tidak butuh Edge
Function/scraper apapun lagi.

## Cara deploy ke GitHub Pages

1. Buat repository baru di GitHub (boleh public), misalnya `fetsipedas-web`.
2. Upload SEMUA file di folder ini (`index.html`, `style.css`, `app.js`,
   `config.js`, `sph-config.js`) ke root repository itu.
   - Paling gampang: di halaman repo GitHub, klik "Add file" -> "Upload files",
     drag semua file sekaligus, lalu "Commit changes".
3. Buka tab **Settings** repo -> menu **Pages** (di sidebar kiri).
4. Di bagian **Source**, pilih branch `main` dan folder `/ (root)`, klik **Save**.
5. Tunggu 1-2 menit, GitHub akan kasih URL seperti:
   `https://<username-github-anda>.github.io/fetsipedas-web/`
6. Buka URL itu -> coba login pakai akun `prov` atau `bps1901` dst yang sudah
   dibuat di Supabase Authentication.

## Yang bisa dicoba sekarang
- Login (role prov & kabkot, dengan hak akses beda sesuai RLS Supabase)
- **Download Data**: ambil data langsung dari database (yang sudah diisi
  aplikasi desktop) lalu export ke Excel. Untuk role `prov` bisa pilih
  kabupaten tertentu atau "Semua Kabupaten/Kota"; untuk role `kabkot`
  otomatis terkunci ke kabupatennya sendiri.
  - File Excel hasil download ini bisa langsung dipakai di aplikasi
    desktop, menu **"3. Rekonsiliasi" → Pilih File Raw → Hasilkan Excel
    Rekon**, untuk mendapatkan Excel dengan dropdown & grafik dinamis
    (fitur ini sengaja TIDAK dibangun ulang di web, cukup pakai yang sudah
    ada di desktop).
- Panel Rekon: pilih jenis SPH, tahun, kabupaten, komoditi, tab
  (Provitas Habis/Belum/Harga atau Provitas/Harga utk BST) -> tabel +
  grafik + highlight outlier kuning (langsung dari data di database, tanpa
  perlu download Excel dulu).
- Info "data terakhir diperbarui" (dari tabel `sync_meta`)

## Yang SUDAH TIDAK ADA di web ini
- Tombol sinkronisasi 4 SPH (SBS/BST/TBF/TH) yang dulu konek langsung ke
  web sipedas asli lewat Edge Function `sync-sph`. Itu sekarang jadi
  tugas aplikasi desktop. Kalau folder `supabase/functions/sync-sph`
  (file `index.ts`) masih ada di project, boleh dihapus — tidak dipakai
  lagi oleh web ini.

## Catatan keamanan
- `config.js` isinya Project URL + `sb_publishable_...` key — ini AMAN
  dipublikasikan di GitHub, memang didesain untuk dipakai di sisi browser.
- Yang TIDAK PERNAH ada di sini: `service_role key` Supabase, dan
  username/password sipedas.pertanian.go.id asli (itu hanya ada di
  konfigurasi aplikasi desktop).
