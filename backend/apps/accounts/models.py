"""Member accounts.

Phase 1 has no login flow — magic-link invites are Phase 2. The model exists now
because swapping AUTH_USER_MODEL after tables reference it is destructive, and because
the privacy rules key off `anchor_person`: every member is pinned to exactly one Person
node in the graph, and their view of living relatives radiates from it.
"""

import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("Users must have an email address")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        # Phase 1 admin users have passwords; invited members (Phase 2) will not.
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(_("email address"), unique=True)
    display_name = models.CharField(_("display name"), max_length=200, blank=True)

    #: The Person this member *is*. Privacy radius and (from Phase 2) card ranking are
    #: both measured from here. Nullable because staff accounts need not be in the graph.
    anchor_person = models.ForeignKey(
        "genealogy.Person",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="anchored_users",
        verbose_name=_("anchor person"),
    )
    preferred_language = models.CharField(
        _("preferred language"),
        max_length=8,
        default="ml",
        choices=[("ml", "Malayalam"), ("en", "English")],
    )

    is_staff = models.BooleanField(_("staff status"), default=False)
    is_active = models.BooleanField(_("active"), default=True)
    date_joined = models.DateTimeField(_("date joined"), default=timezone.now)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        verbose_name = _("user")
        verbose_name_plural = _("users")

    def __str__(self) -> str:
        return self.display_name or self.email
