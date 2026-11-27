(function () {
  const components = flarum.core.compat;
  const IndexPage = components['forum/components/IndexPage'];
  const extend = components.extend.extend;

  components['forum/app'].initializers.add('openwritter-forum', function (app) {
    extend(IndexPage.prototype, 'sidebarItems', function (items) {
      const button = items.get('newDiscussion');
      if (!button || !button.attrs) return;
      const key = button.attrs.disabled ? 'cannot_start_discussion_button' : 'start_discussion_button';
      const label = app.translator.trans('core.forum.index.' + key);
      button.attrs['aria-label'] = Array.isArray(label) ? label.join('') : String(label);
    });
  });
}());

// Flarum 1.x registers the site JavaScript as an extension module.
module.exports = {};
