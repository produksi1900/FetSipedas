// config.js
// Project URL & publishable/anon key SUPABASE — ini AMAN ditaruh di kode
// publik/GitHub (bukan rahasia). Yang wajib dirahasiakan hanya
// "service_role key" dan kredensial sipedas asli (itu semua disimpan di
// Supabase Edge Function Secret, TIDAK PERNAH ada di file ini/di GitHub).

export const SUPABASE_URL = "https://urmqvzbyqfzlgcsuuokw.supabase.co";
export const SUPABASE_KEY = "sb_publishable_IYTUdippTmgyikXMd92-rw_Wn5ld4CI";

// Domain palsu untuk login (username diketik user + ini = email Supabase Auth)
export const EMAIL_DOMAIN = "@fetsipedas.local";

// Provinsi tetap: Bangka Belitung
export const PROV_ID = 19;
