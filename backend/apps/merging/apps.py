from django.apps import AppConfig


class MergingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.merging"
    label = "merging"
    verbose_name = "Merges"
