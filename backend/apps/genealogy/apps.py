from django.apps import AppConfig


class GenealogyConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.genealogy"
    label = "genealogy"
    verbose_name = "Family graph"
