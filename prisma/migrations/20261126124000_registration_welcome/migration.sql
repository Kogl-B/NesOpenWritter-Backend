BEGIN;

-- Приветствие сохраняется в той же транзакции, что и новый аккаунт.
CREATE FUNCTION "create_registration_notice"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "notifications" ("id", "userId", "kind", "title", "body", "href", "eventKey")
    VALUES (
        gen_random_uuid()::text,
        NEW."id",
        'admin_message',
        'Добро пожаловать в OpenWritter!',
        'Читайте и обсуждайте книги, ведите блог и публикуйте свои произведения. Начните с библиотеки или создайте первый проект в кабинете.',
        '/',
        'admin:registration-welcome'
    )
    ON CONFLICT ("userId", "eventKey") DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "users_registration_welcome"
AFTER INSERT ON "users"
FOR EACH ROW EXECUTE FUNCTION "create_registration_notice"();

COMMIT;
