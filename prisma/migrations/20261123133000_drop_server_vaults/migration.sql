-- Пароли, которые сервер мог открыть своим ключом, удаляются.
DELETE FROM "publish_vaults"
WHERE "loginSeal" NOT LIKE 'v1.%' OR "passwordSeal" NOT LIKE 'v1.%';
