from django.contrib.admin.apps import AdminConfig


class AalmaramAdminConfig(AdminConfig):
    """Makes AalmaramAdminSite the default admin site.

    Listed in INSTALLED_APPS in place of "django.contrib.admin". Doing it this way,
    rather than instantiating a site and re-registering every model against it, means
    `django.contrib.admin.site` is already our site and nothing else has to change.
    """

    default_site = "config.admin.AalmaramAdminSite"
