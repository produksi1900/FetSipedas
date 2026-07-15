// supabase/functions/sync-sph/index.ts
//
// Edge Function "sync-sph"
// Dipanggil dari app.js (tombol download panel kiri, KHUSUS role prov).
// Body: { jenis: "sbs"|"bst"|"tbf"|"th", tahun: number }
//
// Alur:
//   1. Verifikasi JWT caller (Authorization header) & pastikan role == "prov"
//      (baca dari tabel profiles pakai service_role, supaya gak bisa dipalsu
//      dari client).
//   2. Login ke sipedas.pertanian.go.id pakai username/password RAHASIA
//      (SIPEDAS_USERNAME / SIPEDAS_PASSWORD, disimpan di Supabase Edge
//      Function Secrets -- TIDAK PERNAH di kode/GitHub).
//   3. Ambil daftar kabupaten -> kecamatan -> loop kolom indikator, scrape
//      tabel HTML (persis logic api_sbs.py/api_bst.py/api_tbf.py/api_th.py).
//   4. Upsert hasil ke tabel data_<jenis> pakai service_role key (bypass RLS).
//   5. Update tabel sync_meta (status: proses -> selesai/gagal).
//
// Port dari: api_core.py, api_sbs.py, api_bst.py, api_tbf.py, api_th.py,
// fitur_sbs.py, fitur_bst.py, fitur_tbf.py, fitur_th.py.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

// ============================================================
// Konfigurasi umum
// ============================================================
const BASE_URL = "https://sipedas.pertanian.go.id";
const LOGIN_URL = `${BASE_URL}/login`;
const BERANDA_URL = `${BASE_URL}/`;
const PROV_ID = 19; // Bangka Belitung (tetap, sama seperti config.js)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ------------------------------------------------------------
// Config per jenis SPH: endpoint, kolom yang diambil, mapping nama
// indikator -> nama kolom Supabase, tipe periode (bulan/triwulan), dan
// parameter q[...] tambahan yang WAJIB dikirim (beda-beda per jenis,
// dikonfirmasi dari HTML capture asli -- lihat komentar di file python).
// ------------------------------------------------------------
type Periode = "bulan" | "triwulan";

interface JenisConfig {
  table: string;                 // nama tabel Supabase tujuan
  endpoint: string;               // path endpoint tabulasi komoditi
  periode: Periode;
  fid: number;                    // q[fid], beda per jenis
  kolMap: Record<string, string>; // kode kolom web -> nama kolom Supabase
}

const JENIS_CONFIG: Record<string, JenisConfig> = {
  sbs: {
    table: "data_sbs",
    endpoint: "/spdsbs/sbstabkom",
    periode: "bulan",
    fid: 10,
    kolMap: {
      lhb: "luas_panen_habis",
      lbh: "luas_panen_belum_habis",
      phb: "produksi_habis",
      pbh: "produksi_belum_habis",
      hjp: "harga_jual_petani",
      ltl: "luas_awal_laporan",
      lrs: "luas_rusak",
      ltt: "luas_tanam",
      lta: "luas_tanaman_akhir",
    },
  },
  tbf: {
    table: "data_tbf",
    endpoint: "/spdtbf/tbftabkom",
    periode: "triwulan",
    fid: 30,
    kolMap: {
      lhb: "luas_panen_habis",
      lbh: "luas_panen_belum_habis",
      phb: "produksi_habis",
      pbh: "produksi_belum_habis",
      hjp: "harga_jual_petani",
      ltl: "luas_awal_laporan",
      lrs: "luas_rusak",
      ltt: "luas_tanam",
      lta: "luas_tanaman_akhir",
    },
  },
  th: {
    table: "data_th",
    endpoint: "/spdthi/thitabkom",
    periode: "triwulan",
    fid: 40,
    kolMap: {
      lhb: "luas_panen_habis",
      phb: "produksi_habis",
      hjp: "harga_jual_petani",
      ltl: "luas_awal_laporan",
      lrs: "luas_rusak",
      ltt: "luas_tanam",
      lta: "luas_tanaman_akhir",
    },
  },
  bst: {
    table: "data_bst",
    endpoint: "/spdbst/bsttabkom",
    periode: "triwulan",
    fid: 20,
    kolMap: {
      prd: "produksi",
      hjp: "harga_jual_petani",
      tpm: "tanaman_produktif_hasil",
      jtl: "jumlah_tanaman_awal",
      jta: "jumlah_tanaman_akhir",
      tbm: "tanaman_belum_menghasilkan",
    },
  },
};

// ============================================================
// Cookie jar sederhana (Deno fetch tidak auto-simpan cookie antar request)
// ============================================================
class CookieJar {
  private cookies = new Map<string, string>();

  applySetCookie(res: Response) {
    // Deno/undici menggabungkan banyak Set-Cookie jadi 1 header dgn koma di
    // sebagian runtime; pakai getSetCookie() kalau tersedia, fallback split.
    // deno-lint-ignore no-explicit-any
    const anyHeaders = res.headers as any;
    const raw: string[] =
      typeof anyHeaders.getSetCookie === "function"
        ? anyHeaders.getSetCookie()
        : (res.headers.get("set-cookie") ?? "").split(/,(?=[^;]+?=)/);
    for (const line of raw) {
      const pair = line.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (name) this.cookies.set(name, val);
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

async function fetchWithJar(jar: CookieJar, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("User-Agent", UA);
  const cookieHeader = jar.header();
  if (cookieHeader) headers.set("Cookie", cookieHeader);
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.applySetCookie(res);
  return res;
}

// Ikuti redirect manual (supaya cookie di tiap loncatan tetap ke-capture).
async function fetchFollow(jar: CookieJar, url: string, init: RequestInit = {}) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetchWithJar(jar, cur, init);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      cur = new URL(loc, cur).toString();
      init = { method: "GET" }; // redirect selalu GET
      continue;
    }
    return res;
  }
  return fetchWithJar(jar, cur, init);
}

function parseHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) throw new Error("Gagal parse HTML.");
  return doc;
}

function ambilCsrf(doc: Document): string | null {
  const inputTag = doc.querySelector('input[name="_csrf"]') as HTMLInputElement | null;
  if (inputTag?.getAttribute("value")) return inputTag.getAttribute("value");
  const metaTag = doc.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null;
  if (metaTag?.getAttribute("content")) return metaTag.getAttribute("content");
  return null;
}

// ============================================================
// Login (port dari api_core.py: login())
// ============================================================
async function login(username: string, password: string): Promise<CookieJar> {
  const jar = new CookieJar();

  const resLogin = await fetchFollow(jar, LOGIN_URL);
  const docLogin = parseHtml(await resLogin.text());
  const csrf = ambilCsrf(docLogin);
  if (!csrf) throw new Error("Tidak dapat mengambil token _csrf dari halaman login.");

  const form = new URLSearchParams({
    _csrf: csrf,
    "LoginForm[username]": username,
    "LoginForm[password]": password,
    "LoginForm[rememberMe]": "0",
    "login-button": "",
  });

  const resPost = await fetchFollow(jar, LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const finalUrl = resPost.url || "";
  const htmlLower = (await resPost.text()).toLowerCase();
  if (finalUrl.includes("/login") || htmlLower.includes("username atau password salah")) {
    throw new Error("Login ke sipedas gagal: username/password salah atau ditolak server.");
  }
  return jar;
}

async function ambilCsrfDariBeranda(jar: CookieJar): Promise<string> {
  const res = await fetchFollow(jar, BERANDA_URL);
  const doc = parseHtml(await res.text());
  const csrf = ambilCsrf(doc);
  if (!csrf) throw new Error("Gagal mengambil csrf token dari beranda.");
  return csrf;
}

// ============================================================
// Daftar kabupaten & kecamatan (port dari api_core.py)
// ============================================================
async function getDaftarKabupaten(jar: CookieJar, tahun: number) {
  const csrf = await ambilCsrfDariBeranda(jar);
  const body = new URLSearchParams({
    "depdrop_parents[0]": "13",
    "depdrop_parents[1]": String(tahun),
    "depdrop_parents[2]": String(PROV_ID),
    "depdrop_parents[3]": "",
    "depdrop_all_params[q-lvl]": "13",
    "depdrop_all_params[q-thn]": String(tahun),
    "depdrop_all_params[q-pro]": String(PROV_ID),
    "depdrop_all_params[q-kabc]": "",
    _csrf: csrf,
  });
  const res = await fetchWithJar(jar, `${BASE_URL}/depwil/kabupaten`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE_URL}/spdsbs/sbstabkom`,
    },
    body: body.toString(),
  });
  const data = await res.json();
  return (data.output ?? []) as { id: string; name: string }[];
}

async function getDaftarKecamatan(jar: CookieJar, kabId: string, tahun: number) {
  const csrf = await ambilCsrfDariBeranda(jar);
  const body = new URLSearchParams({
    "depdrop_parents[0]": "13",
    "depdrop_parents[1]": String(tahun),
    "depdrop_parents[2]": String(PROV_ID),
    "depdrop_parents[3]": kabId,
    "depdrop_parents[4]": "",
    "depdrop_all_params[q-lvl]": "13",
    "depdrop_all_params[q-thn]": String(tahun),
    "depdrop_all_params[q-pro]": String(PROV_ID),
    "depdrop_all_params[q-kab]": kabId,
    "depdrop_all_params[q-kecc]": "",
    _csrf: csrf,
  });
  const res = await fetchWithJar(jar, `${BASE_URL}/depwil/kecamatan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE_URL}/spdsbs/sbstabkom`,
    },
    body: body.toString(),
  });
  const data = await res.json();
  return (data.output ?? []) as { id: string; name: string }[];
}

// ============================================================
// Scrape 1 kolom indikator utk 1 kecamatan (port dari
// get_tabulasi_komoditi_kol di api_sbs.py/api_bst.py/api_tbf.py/api_th.py)
// ============================================================
interface BarisMentah {
  kode: string;
  nama: string;
  periode: number; // 1-12 (bulan) atau 1-4 (triwulan)
  nilai: number;
}

function parseNilai(v: string): number {
  const s = (v ?? "").trim();
  if (s === "-" || s === "") return 0;
  const bersih = s.replace(/\./g, "").replace(",", ".");
  const n = Number(bersih);
  return Number.isNaN(n) ? 0 : n;
}

async function ambilKolomKec(
  jar: CookieJar,
  cfg: JenisConfig,
  kabId: string,
  kecId: string,
  kol: string,
  tahun: number,
): Promise<BarisMentah[]> {
  const params = new URLSearchParams({
    "q[lvc]": "11", "q[blc]": "7", "q[twc]": "3", "q[proc]": String(PROV_ID),
    "q[kabc]": kabId, "q[kecc]": kecId, "q[desc]": "",
    "q[lv2c]": "13", "q[lv2x]": "13", "q[fid]": String(cfg.fid), "q[pil]": "40",
    "q[lvl]": "13", "q[thn]": String(tahun), "q[bln]": "6", "q[tw]": "2",
    "q[th1]": String(tahun), "q[bl1]": "1", "q[tw1]": "1",
    "q[bl2]": "12", "q[tw2]": "4", "q[th2]": String(tahun),
    "q[lkp]": "", "q[lv2]": "13", "q[pro]": String(PROV_ID),
    "q[kab]": kabId, "q[kec]": kecId, "q[kom]": "",
    "q[kol]": kol, "q[okv]": "10", "q[ofm]": "1", "q[val]": "per",
    "q[hdr]": "9",
  });
  const url = `${BASE_URL}${cfg.endpoint}?${params.toString()}`;
  const res = await fetchWithJar(jar, url);
  const doc = parseHtml(await res.text());

  let tabel = doc.querySelector("table.kv-grid-table");
  if (!tabel) {
    const semua = Array.from(doc.querySelectorAll("table"));
    tabel = semua.find((t) => {
      const id = (t as Element).getAttribute("id");
      return id !== "tbu_id" && id !== "tbp_id";
    }) as Element | null ?? null;
  }
  if (!tabel) return [];

  const trs = Array.from((tabel as Element).querySelectorAll("tr"));
  let headerCells: string[] | null = null;
  const idxPeriode: Record<string, number> = {};
  let iKode = -1, iNama = -1;
  const hasil: BarisMentah[] = [];

  const labelPeriode =
    cfg.periode === "bulan"
      ? ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"]
      : ["Tw1", "Tw2", "Tw3", "Tw4"];

  for (const tr of trs) {
    const cells = Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent.trim());
    if (cells.length === 0) continue;

    if (!headerCells) {
      const punyaKodeNama = cells.includes("Kode") && cells.includes("Nama");
      const punyaKodeKomoditas = cells.includes("Kode") && cells.includes("Komoditas");
      const punyaKodeSatuanTw = cells.includes("Kode") && cells.includes("Satuan") && cells.includes("Tw1");
      if (punyaKodeNama || punyaKodeKomoditas || punyaKodeSatuanTw) {
        headerCells = cells;
        iKode = cells.indexOf("Kode");
        iNama = punyaKodeSatuanTw ? iKode + 1 : cells.indexOf(punyaKodeNama ? "Nama" : "Komoditas");
        labelPeriode.forEach((p) => {
          if (cells.includes(p)) idxPeriode[p] = cells.indexOf(p);
        });
      }
      continue;
    }

    // skip baris nomor urut kolom ('1','2','3'...)
    if (cells.every((v, i) => v === String(i + 1))) continue;

    const kode = cells[iKode];
    const nama = cells[iNama];
    if (!kode || kode.toLowerCase() === "kode" || kode.toLowerCase() === "jumlah") continue;

    labelPeriode.forEach((p, i) => {
      const idx = idxPeriode[p];
      if (idx === undefined || idx >= cells.length) return;
      hasil.push({ kode, nama, periode: i + 1, nilai: parseNilai(cells[idx]) });
    });
  }

  return hasil;
}

// ============================================================
// Handler utama
// ============================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { jenis, tahun } = await req.json();
    const cfg = JENIS_CONFIG[jenis];
    if (!cfg) {
      return json({ ok: false, pesan: `Jenis SPH tidak dikenali: ${jenis}` }, 400);
    }
    if (!tahun || Number.isNaN(Number(tahun))) {
      return json({ ok: false, pesan: "Tahun tidak valid." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    // ---- 1. Verifikasi caller: harus login & role == 'prov' ----
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ ok: false, pesan: "Tidak ada token otorisasi." }, 401);

    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ ok: false, pesan: "Token tidak valid / sesi habis." }, 401);
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile || profile.role !== "prov") {
      return json({ ok: false, pesan: "Hanya akun provinsi yang boleh sinkronisasi." }, 403);
    }

    // ---- 2. Tandai status "proses" di sync_meta ----
    await supabaseAdmin.from("sync_meta").upsert({
      jenis, tahun, status: "proses", pesan: "Login & mengambil data...",
      last_synced_at: new Date().toISOString(),
    }, { onConflict: "jenis,tahun" });

    // ---- 3. Login ke sipedas asli ----
    const username = Deno.env.get("SIPEDAS_USERNAME");
    const password = Deno.env.get("SIPEDAS_PASSWORD");
    if (!username || !password) {
      throw new Error("SIPEDAS_USERNAME / SIPEDAS_PASSWORD belum diset di Edge Function Secrets.");
    }
    const jar = await login(username, password);

    // ---- 4. Loop kabupaten -> kecamatan -> kolom ----
    const daftarKab = await getDaftarKabupaten(jar, Number(tahun));
    if (daftarKab.length === 0) throw new Error("Gagal mengambil daftar kabupaten (cek tahun / login).");

    const gabung = new Map<string, Record<string, unknown>>();
    let urutkecCounter = 1;

    for (const kab of daftarKab) {
      const daftarKec = await getDaftarKecamatan(jar, kab.id, Number(tahun));
      urutkecCounter = 1;
      for (const kec of daftarKec) {
        const urutkec = urutkecCounter++;
        for (const [kolKode, kolNama] of Object.entries(cfg.kolMap)) {
          let baris: BarisMentah[] = [];
          try {
            baris = await ambilKolomKec(jar, cfg, kab.id, kec.id, kolKode, Number(tahun));
          } catch (_e) {
            continue; // skip kolom yg gagal, lanjut kolom lain
          }
          for (const b of baris) {
            const key = `${kab.id}|${kec.id}|${b.kode}|${b.periode}`;
            if (!gabung.has(key)) {
              gabung.set(key, {
                tahun: Number(tahun),
                kab: kab.id,
                nama_kab: kab.name,
                kec: kec.id,
                nama_kec: kec.name,
                urutkec,
                idtanaman: b.kode,
                namatanaman: b.nama,
                [cfg.periode]: b.periode,
                updated_at: new Date().toISOString(),
              });
            }
            (gabung.get(key) as Record<string, unknown>)[kolNama] = b.nilai;
          }
        }
      }
      await supabaseAdmin.from("sync_meta").upsert({
        jenis, tahun, status: "proses",
        pesan: `Selesai kab ${kab.name}...`,
        last_synced_at: new Date().toISOString(),
      }, { onConflict: "jenis,tahun" });
    }

    const rows = Array.from(gabung.values());
    if (rows.length === 0) throw new Error("Tidak ada data yang berhasil di-scrape.");

    // ---- 5. Upsert ke Supabase (batch, hindari payload kegedean) ----
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error: upsertErr } = await supabaseAdmin
        .from(cfg.table)
        .upsert(batch, { onConflict: `tahun,kab,kec,idtanaman,${cfg.periode}` });
      if (upsertErr) throw new Error(`Gagal upsert batch ${i}: ${upsertErr.message}`);
    }

    await supabaseAdmin.from("sync_meta").upsert({
      jenis, tahun, status: "selesai",
      pesan: `Sinkronisasi selesai, ${rows.length} baris.`,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: "jenis,tahun" });

    return json({ ok: true, jumlah_baris: rows.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabaseAdmin = createClient(supabaseUrl, serviceKey);
      const body = await req.clone().json().catch(() => ({}));
      if (body?.jenis && body?.tahun) {
        await supabaseAdmin.from("sync_meta").upsert({
          jenis: body.jenis, tahun: body.tahun, status: "gagal", pesan: msg,
          last_synced_at: new Date().toISOString(),
        }, { onConflict: "jenis,tahun" });
      }
    } catch (_ignore) { /* noop */ }
    return json({ ok: false, pesan: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
