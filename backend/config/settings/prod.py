"""Production settings.

Everything secret comes from the environment and **fails loudly if missing**. There are no
usable defaults here on purpose: a production process that silently boots with a dev secret
key, or with ALLOWED_HOSTS wide open, is worse than one that refuses to start.

TLS is terminated by Caddy, which talks to gunicorn over the private compose network. That
is why SECURE_PROXY_SSL_HEADER is set — without it Django cannot tell the original request
was HTTPS and SECURE_SSL_REDIRECT would loop forever.
"""

import os

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import BASE_DIR, DATABASES, INSTALLED_APPS, MIDDLEWARE, env_list


def required(name: str) -> str:
    """Read a setting that has no safe default."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise ImproperlyConfigured(
            f"{name} is not set. Production refuses to start without it — "
            f"see .env.production.example."
        )
    return value


DEBUG = False
SECRET_KEY = required("DJANGO_SECRET_KEY")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS")
if not ALLOWED_HOSTS:
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS is not set. Refusing to serve any host.")

#: e.g. https://family.bulkbeing.in — needed for admin POSTs and the quick-add API.
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")
if not CSRF_TRUSTED_ORIGINS:
    raise ImproperlyConfigured("DJANGO_CSRF_TRUSTED_ORIGINS is not set.")

DATABASES["default"]["PASSWORD"] = required("POSTGRES_PASSWORD")
# Reuse connections; low traffic, but every request otherwise pays TCP + auth setup.
DATABASES["default"]["CONN_MAX_AGE"] = 60

# --- transport security ------------------------------------------------------
# Only trust the forwarded-proto header because nothing but Caddy can reach gunicorn:
# the backend publishes no host port at all.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True

SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 60 * 60 * 24 * 14  # two weeks

CSRF_COOKIE_SECURE = True
# Deliberately not HTTPONLY: the explorer reads this cookie to set X-CSRFToken on quick-add.
CSRF_COOKIE_HTTPONLY = False
CSRF_COOKIE_SAMESITE = "Lax"

SECURE_HSTS_SECONDS = 31536000  # one year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
# Deliberately NOT preloading: preload is submitted for the apex domain and is effectively
# irreversible for every other bulkbeing.in host. See DECISIONS.md #20.
SECURE_HSTS_PRELOAD = False

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# CORS is meaningless here: Caddy serves the SPA from the same origin as the API.
CORS_ALLOWED_ORIGINS = []

# --- static files ------------------------------------------------------------
# WhiteNoise serves Django's own admin assets straight from gunicorn. Caddy serves the
# built SPA; a second static mount would only duplicate that.
STATIC_ROOT = BASE_DIR / "staticfiles"
_middleware = list(MIDDLEWARE)
_middleware.insert(
    _middleware.index("django.middleware.security.SecurityMiddleware") + 1,
    "whitenoise.middleware.WhiteNoiseMiddleware",
)

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

# --- login rate limiting -----------------------------------------------------
# The admin login is the only door into this deployment and it faces the open internet,
# so it gets a lockout rather than relying on password strength alone.
INSTALLED_APPS = [*INSTALLED_APPS, "axes"]
AUTHENTICATION_BACKENDS = [
    "axes.backends.AxesStandaloneBackend",  # must be first
    "django.contrib.auth.backends.ModelBackend",
]
MIDDLEWARE = [*_middleware, "axes.middleware.AxesMiddleware"]  # axes must be last

AXES_ENABLED = True
AXES_FAILURE_LIMIT = 5
AXES_COOLOFF_TIME = 1  # hours
AXES_RESET_ON_SUCCESS = True
AXES_LOCKOUT_PARAMETERS = ["ip_address", "username"]
# Behind Caddy every request looks like it came from the proxy unless the header is read.
AXES_IPWARE_PROXY_COUNT = 1
AXES_IPWARE_META_PRECEDENCE_ORDER = ["HTTP_X_FORWARDED_FOR", "REMOTE_ADDR"]

# --- logging -----------------------------------------------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "{levelname} {asctime} {name} {message}", "style": "{"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django.request": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "axes": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}
