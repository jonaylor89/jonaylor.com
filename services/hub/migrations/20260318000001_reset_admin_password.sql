-- Reset admin password (change immediately after login via /admin/password)
UPDATE users
SET password_hash = '$argon2id$v=19$m=15000,t=2,p=1$P66edN3mzaFAJnb86Jd0zg$obEKgIFboRdvlwcFhdEMtfn34REvNtcs2MsAkJGVp6I'
WHERE username = 'admin';
