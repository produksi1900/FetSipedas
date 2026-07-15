# Deploy Edge Function `sync-sph`

## 1. Prasyarat DB (jalankan sekali di SQL Editor Supabase kalau belum ada)

```sql
-- Supaya upsert sync_meta & data_* bekerja (ON CONFLICT butuh unique constraint)
alter table sync_meta
  add constraint sync_meta_jenis_tahun_uniq unique (jenis, tahun);

alter table data_sbs
  add constraint data_sbs_uniq unique (tahun, kab, kec, idtanaman, bulan);
alter table data_tbf
  add constraint data_tbf_uniq unique (tahun, kab, kec, idtanaman, triwulan);
alter table data_th
  add constraint data_th_uniq unique (tahun, kab, kec, idtanaman, triwulan);
alter table data_bst
  add constraint data_bst_uniq unique (tahun, kab, kec, idtanaman, triwulan);
```

Sesuaikan nama constraint dengan struktur kolommu kalau beda dari yang aku
asumsikan (cek dulu lewat `information_schema.columns`, yang sudah kamu
export ke CSV).

## 2. Install Supabase CLI (kalau belum)

```bash
npm install -g supabase
supabase login
supabase link --project-ref urmqvzbyqfzlgcsuuokw
```

## 3. Set secrets (JANGAN taruh di kode / GitHub)

```bash
supabase secrets set SIPEDAS_USERNAME="username_asli_sipedas"
supabase secrets set SIPEDAS_PASSWORD="password_asli_sipedas"
```

`SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` otomatis tersedia di semua
Edge Function, tidak perlu di-set manual.

## 4. Deploy

```bash
supabase functions deploy sync-sph
```

## 5. Test cepat (pakai token login akun prov)

```bash
curl -X POST \
  "https://urmqvzbyqfzlgcsuuokw.supabase.co/functions/v1/sync-sph" \
  -H "Authorization: Bearer <access_token_akun_prov>" \
  -H "apikey: <SUPABASE_KEY_publishable>" \
  -H "Content-Type: application/json" \
  -d '{"jenis":"sbs","tahun":2025}'
```

## Catatan performa

Untuk 1 kabupaten x ~10 kecamatan x 9 kolom indikator, itu ~90 request
sequential ke sipedas per kabupaten. Kalau Bangka Belitung ada 7 kab, total
bisa 600+ request -> Edge Function Supabase punya batas waktu eksekusi
(default beberapa menit). Kalau nanti kena timeout:

- Panggil function ini PER KABUPATEN dari frontend (loop di app.js, kirim
  `{jenis, tahun, kab_id}` satu-satu), bukan sekali panggil untuk semua kab.
- Atau paralelkan `ambilKolomKec` pakai `Promise.all` per kecamatan (hati-hati
  jangan terlalu agresif, bisa kena rate-limit/block dari server sipedas).

Aku sengaja bikin versi sequential dulu (lebih aman & gampang di-debug) --
kalau kena timeout beneran, kasih tahu aku, nanti aku pecah jadi per-kabupaten.
