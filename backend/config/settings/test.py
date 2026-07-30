"""Test settings: same Postgres 16 engine as production, faster hashing."""

from .base import *  # noqa: F403

DEBUG = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# Keep migrations on: the recursive CTEs depend on real table/column names and the
# pg_trgm extension, so tests must run against a genuinely migrated schema.
