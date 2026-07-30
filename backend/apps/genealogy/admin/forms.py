"""Forms for the custom admin pages."""

from django import forms
from django.contrib import admin
from django.contrib.admin.widgets import AutocompleteSelect
from django.utils.translation import gettext_lazy as _

from apps.genealogy.models import Gender, Person, UnionMembership, UnionType


def person_picker(label, required=False):
    """A searchable person select, reusing the admin's own autocomplete endpoint."""
    return forms.ModelChoiceField(
        label=label,
        required=required,
        queryset=Person.objects.canonical(),
        widget=AutocompleteSelect(UnionMembership._meta.get_field("person"), admin.site),
    )


class RelateForm(forms.Form):
    # Field names are the query-string names: /admin/genealogy/relate/?a=…&b=…
    a = person_picker(_("Person A"), required=True)
    b = person_picker(_("Person B"), required=True)


class ExplorerForm(forms.Form):
    person = person_picker(_("Person"), required=True)
    depth = forms.IntegerField(label=_("Generations to show"), min_value=1, max_value=10, initial=4)


class QuickAddFamilyForm(forms.Form):
    """Enter a whole household in one submit.

    This is the seed-entry path: two partners, a stack of children typed as plain text,
    and one house name applied to everyone new. Getting 200+ people in means never
    making the user open a second screen to add a child.
    """

    existing_partner_1 = person_picker(_("Partner 1 — existing person"))
    new_partner_1 = forms.CharField(label=_("…or new name"), required=False, max_length=200)
    new_partner_1_gender = forms.ChoiceField(
        label=_("Gender"), choices=Gender.choices, initial=Gender.MALE, required=False
    )

    existing_partner_2 = person_picker(_("Partner 2 — existing person"))
    new_partner_2 = forms.CharField(label=_("…or new name"), required=False, max_length=200)
    new_partner_2_gender = forms.ChoiceField(
        label=_("Gender"), choices=Gender.choices, initial=Gender.FEMALE, required=False
    )

    union_type = forms.ChoiceField(
        label=_("Union type"), choices=UnionType.choices, initial=UnionType.MARRIAGE
    )
    union_year = forms.IntegerField(label=_("Year of union"), required=False)
    union_place = forms.CharField(label=_("Place"), required=False, max_length=200)

    house_name = forms.CharField(
        label=_("House name (veedu / tharavadu)"),
        required=False,
        max_length=200,
        help_text=_("Applied to every new person created on this screen."),
    )
    children = forms.CharField(
        label=_("Children"),
        required=False,
        widget=forms.Textarea(attrs={"rows": 8, "cols": 60}),
        help_text=_(
            "One per line, oldest first — line order becomes the sibling order. "
            "Optionally add gender and birth year: <code>Thomas | m | 1942</code>. "
            "Append <code>| adopted</code> or <code>| step</code> to mark the relation."
        ),
    )

    def clean(self):
        cleaned = super().clean()
        partner_1 = cleaned.get("existing_partner_1") or cleaned.get("new_partner_1")
        partner_2 = cleaned.get("existing_partner_2") or cleaned.get("new_partner_2")
        if not partner_1 and not partner_2:
            raise forms.ValidationError(
                _("Name at least one partner — a union with a single known partner is fine.")
            )
        if cleaned.get("existing_partner_1") and cleaned.get("new_partner_1"):
            self.add_error(
                "new_partner_1", _("Pick an existing person or type a new name, not both.")
            )
        if cleaned.get("existing_partner_2") and cleaned.get("new_partner_2"):
            self.add_error(
                "new_partner_2", _("Pick an existing person or type a new name, not both.")
            )
        return cleaned
