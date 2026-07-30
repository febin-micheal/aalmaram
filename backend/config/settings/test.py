"""Test settings: same Postgres 16 engine as production, faster hashing."""

from .base import *  # noqa: F403

DEBUG = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# django-axes ships in production only (see prod.py). Pinned off here so a future move
# into base settings cannot silently start locking out the test client mid-suite.
AXES_ENABLED = False

# Keep migrations on: the recursive CTEs depend on real table/column names and the
# pg_trgm extension, so tests must run against a genuinely migrated schema.
