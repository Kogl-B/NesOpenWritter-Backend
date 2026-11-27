<?php

declare(strict_types=1);

use Flarum\Extension\ExtensionManager;
use Flarum\Settings\SettingsRepositoryInterface;

$site = require '/flarum/app/site.php';
$container = $site->bootApp()->getContainer();
$container->make(ExtensionManager::class)->enable('flarum-lang-russian');

$settings = $container->make(SettingsRepositoryInterface::class);
$settings->set('default_locale', 'ru');
if ($settings->get('welcome_title') === 'Welcome to Flarum') {
    $settings->set('welcome_title', 'Обсуждения OpenWritter');
}
if ($settings->get('welcome_message') === 'Enjoy your new forum! Hop over to discuss.flarum.org if you have any questions, or to join our community!') {
    $settings->set('welcome_message', 'Обсуждайте книги, делитесь опытом и задавайте вопросы о работе с OpenWritter.');
}
