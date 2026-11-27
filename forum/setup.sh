#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd /flarum/app
flarum_user="${UID:-991}:${GID:-991}"

forum_port="${FLARUM_PORT:-8888}"

# The base image starts nginx after its own Composer and database setup.
attempt=0
until php -r '$s = @fsockopen("127.0.0.1", (int) $argv[1], $code, $message, 1); exit($s ? 0 : 1);' "$forum_port" \
  && [ -s config.php ] && su-exec "$flarum_user" php flarum info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 45 ]; then
    echo 'Flarum did not become ready for OpenWritter setup.' >&2
    exit 1
  fi
  sleep 2
done

if ! php -r 'require "vendor/autoload.php"; exit(Composer\InstalledVersions::isInstalled("flarum-lang/russian") ? 0 : 1);'; then
  # Last available Russian pack compatible with the Flarum 1.3 base image.
  COMPOSER_NO_INTERACTION=1 extension require 'flarum-lang/russian:1.4.0-p1'
  php -r 'require "vendor/autoload.php"; exit(Composer\InstalledVersions::isInstalled("flarum-lang/russian") ? 0 : 1);'
fi

mkdir -p extensions/openwritter
cp "$source_dir/forum.js" extensions/openwritter/forum.js
chown "$flarum_user" extensions/openwritter extensions/openwritter/forum.js
su-exec "$flarum_user" php <<'PHP'
<?php
$path = '/flarum/app/extend.php';
$contents = file_get_contents($path);
if ($contents === false) {
    throw new RuntimeException('Flarum extend.php is unreadable.');
}
if (strpos($contents, '/extensions/openwritter/forum.js') === false) {
    $source = <<<'EXTENDER'
return [
    (new \Flarum\Extend\Frontend('forum'))->js(__DIR__.'/extensions/openwritter/forum.js'),
EXTENDER;
    $next = preg_replace('/^return\s*\[/m', $source, $contents, 1, $matches);
    if ($matches !== 1 || $next === null) {
        throw new RuntimeException('Flarum extend.php does not contain an extender array.');
    }
    $pending = tempnam(dirname($path), 'extend-');
    if ($pending === false || file_put_contents($pending, $next) !== strlen($next) || !rename($pending, $path)) {
        throw new RuntimeException('Cannot register the OpenWritter forum extension.');
    }
}
PHP
su-exec "$flarum_user" php "$source_dir/configure.php"
su-exec "$flarum_user" php flarum cache:clear
