"""Pytest fixtures shared across apps.

The fixture families live in apps.genealogy.fixtures.families and are exposed here so
every test module can request them by name.
"""

import pytest

from apps.genealogy.fixtures import families


@pytest.fixture
def family_a(db):
    """Five-generation fictional family: remarriage, half-siblings, unknown parent."""
    return families.build_family_a()


@pytest.fixture
def family_b(db):
    """A second, disconnected fictional family."""
    return families.build_family_b()


@pytest.fixture
def two_families(db):
    """Both families, unconnected — used for 'no common ancestor' assertions."""
    return families.build_family_a(), families.build_family_b()


@pytest.fixture
def bridged_families(db):
    """Both families joined by a marriage in the youngest generation."""
    return families.build_bridged_families()


@pytest.fixture
def duplicate_pair(db):
    """The same person entered twice by two contributors — merge test material."""
    return families.build_duplicate_pair()
