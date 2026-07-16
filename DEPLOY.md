# DEPLOY.md — SUDAH TIDAK DIPAKAI

File ini dulu berisi panduan deploy Edge Function `sync-sph` (scraper yang
konek dari Supabase ke web sipedas.pertanian.go.id asli, dipanggil dari
tombol download di web).

Sekarang proses sinkronisasi/scraping itu sepenuhnya dilakukan oleh
**aplikasi desktop FetSipedas** (lewat `supabase_uploader.py`), bukan lewat
web lagi. Web hanya membaca data yang sudah ada di database.

Yang boleh dilakukan sekarang:
- **Hapus** folder `supabase/functions/sync-sph/` (isi file `index.ts`)
  kalau masih ada di project — tidak dipanggil oleh web ini lagi.
- **Hapus file ini** (`DEPLOY.md`) kalau mau, sudah tidak relevan.

Konstrain database (unique constraint utk `sync_meta` & tabel `data_*`,
lihat SQL di bawah) tetap relevan kalau belum pernah dijalankan, karena
`supabase_uploader.py` di desktop juga melakukan upsert dengan
`on_conflict` yang butuh unique constraint ini:

```sql
alter table sync_meta
  add constraint sync_meta_jenis_tahun_uniq unique (jenis, tahun);

alter table data_sbs
  add constraint data_sbs_uniq unique (tahun, kab, kec, namatanaman, bulan);
alter table data_tbf
  add constraint data_tbf_uniq unique (tahun, kab, kec, namatanaman, triwulan);
alter table data_th
  add constraint data_th_uniq unique (tahun, kab, kec, namatanaman, triwulan);
alter table data_bst
  add constraint data_bst_uniq unique (tahun, kab, kec, namatanaman, triwulan);
```

(Catatan: kolom unique di atas disamakan dengan `on_conflict` yang dipakai
`supabase_uploader.py` di desktop, yaitu `tahun,kab,kec,namatanaman,<periode>`
— bukan `idtanaman` seperti draf lama.)
