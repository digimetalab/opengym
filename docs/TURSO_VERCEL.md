# Panduan Deploy openGym ke Vercel + Turso Database

openGym sekarang mendukung **Turso (libSQL / Serverless SQLite)** sebagai database cloud persisten, serta konfigurasi serverless function untuk **Vercel**.

Dengan kombinasi ini, Anda dapat menjalankan openGym secara **100% gratis (Serverless Free Tier)** dengan data tersinkronisasi antar perangkat.

---

## 1. Persiapan Database di Turso

1. Kunjungi [turso.tech](https://turso.tech) dan buat akun gratis.
2. Buat database baru (bisa melalui web dashboard Turso atau via CLI):
   ```bash
   turso db create opengym-db
   ```
3. Dapatkan **Database URL**:
   ```bash
   turso db show opengym-db --url
   # Contoh output: libsql://opengym-db-yourusername.turso.io
   ```
4. Dapatkan **Auth Token**:
   ```bash
   turso db tokens create opengym-db
   # Salin token panjang yang dihasilkan
   ```

*Catatan: Tabel database (`app_meta`, `app_auth`, `user_states`, `app_ephemeral`, `audit_logs`) akan otomatis dibuat oleh server saat pertama kali dijalankan.*

---

## 2. Deploy ke Vercel

### Opsi A: Melalui Vercel Dashboard (Paling Mudah)
1. Push repositori ini ke GitHub / GitLab Anda.
2. Buka [vercel.com](https://vercel.com) dan klik **Add New Project**.
3. Import repositori openGym.
4. Di bagian **Environment Variables**, tambahkan:

| Variabel | Nilai Contoh | Keterangan |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://opengym-db-user.turso.io` | URL database Turso Anda |
| `TURSO_AUTH_TOKEN` | `eyJhbGciOi...` | Auth token Turso Anda |
| `ORIGIN` | `https://opengym-anda.vercel.app` | URL domain Vercel Anda (lengkap dengan https://) |
| `RP_ID` | `opengym-anda.vercel.app` | Hostname untuk Passkey (tanpa https://) |
| `MEDIA_UPLOADS` | `0` | Nonaktifkan upload disk lokal di serverless |
| `VITE_IMG_BASE` | `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/` | CDN gambar demo latihan |
| `VITE_GIF_BASE` | `https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/` | CDN animasi video demo latihan |

5. Klik **Deploy**.

---

### Opsi B: Melalui Vercel CLI
```bash
npm install -g vercel
vercel
```
Ikuti instruksi di terminal dan tambahkan environment variable di atas melalui menu pengaturan di Vercel Dashboard atau `vercel env add`.

---

## 3. Fitur yang Didukung di Vercel + Turso

- [x] **Passkey / WebAuthn Login**: Berfungsi normal di domain Vercel HTTPS (`RP_ID` sesuai domain).
- [x] **Multi-device Sync**: Data latihan per profil tersimpan di tabel `user_states` Turso.
- [x] **Ephemeral Challenges & Pairing**: Tersimpan di database Turso, aman dari cold-boot serverless multi-instance.
- [x] **Katalog 1.300+ Latihan**: Demo animasi diload langsung via CDN gratis.
- [x] **Fallback Aman**: Jika `TURSO_DATABASE_URL` tidak diisi (misal dijalankan di Docker lokal), sistem otomatis beralih kembali ke file lokal tanpa error.
