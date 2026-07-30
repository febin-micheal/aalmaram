"""Fictional fixture families.

⚠ Everything in this file is invented. No real person, family, house name or place
appears here — this repository is public. The names are ordinary Malayali given names
combined with made-up house names.

Two families are defined, plus the awkward cases every graph function has to survive:

**Kavunkal (family A)** — six generations, and deliberately messy:

    Ittira ─┬─ Mariam                                   (G1, union: u_g1)
            │
      ┌─────┼──────────────┬───────────────┐
    Chacko  │           Eliyamma        Devassy ─┬─ Kunjamma        (G2)
      │     │               │                    │
      │     └── remarriage ─┴── unknown father   ├── Baby
      │                                          └── Ouseph (adopted)
      ├─ Annamma (u_chacko_1, she dies) ──┬── Thomas
      │                                   └── Rosy
      └─ Saramma (u_chacko_2)             ┬── Joseph
                                          └── Lucy

    Thomas/Rosy and Joseph/Lucy are half-siblings — they share Chacko and nothing else.
    Eliyamma's son Varkey has a mother and no recorded father: his union of birth has a
    single partner. Ouseph is adopted, and traversal must still treat him as a child of
    that union while relation_type keeps the distinction visible.

**Palathinkal (family B)** — a separate, unconnected component, so that "no common
ancestor" can be asserted rather than assumed. `build_bridged_families()` marries the
two youngest generations together: that joins the components for privacy-radius purposes
while creating no blood relationship at all.
"""

from types import SimpleNamespace

from apps.genealogy.factories import make_person, make_union
from apps.genealogy.models import Gender, RelationType, UnionStatus, UnionType

F = Gender.FEMALE
M = Gender.MALE

KAVUNKAL = "Kavunkal"
PALATHINKAL = "Palathinkal"
VAZHAKKUNNATHIL = "Vazhakkunnathil"


def build_family_a() -> SimpleNamespace:
    """Six generations of the fictional Kavunkal family."""
    # --- G1 ---------------------------------------------------------------
    ittira = make_person("Ittira", gender=M, birth=1890, house=KAVUNKAL)
    mariam = make_person("Mariam", gender=F, birth=1893, house="Chalil")
    chacko = make_person("Chacko", gender=M, birth=1915, house=KAVUNKAL)
    eliyamma = make_person("Eliyamma", gender=F, birth=1918, house=KAVUNKAL)
    devassy = make_person("Devassy", gender=M, birth=1921, house=KAVUNKAL)
    u_g1 = make_union(
        ittira,
        mariam,
        children=[
            (chacko, RelationType.BIOLOGICAL, 1),
            (eliyamma, RelationType.BIOLOGICAL, 2),
            (devassy, RelationType.BIOLOGICAL, 3),
        ],
        year=1912,
        status=UnionStatus.ENDED,
    )

    # --- G2: Chacko marries twice; the two sets of children are half-siblings ---
    annamma = make_person("Annamma", gender=F, birth=1920, house="Puthenveedu")
    thomas = make_person("Thomas", gender=M, birth=1942, house=KAVUNKAL)
    rosy = make_person("Rosy", gender=F, birth=1945, house=KAVUNKAL)
    u_chacko_1 = make_union(
        chacko,
        annamma,
        children=[(thomas, RelationType.BIOLOGICAL, 1), (rosy, RelationType.BIOLOGICAL, 2)],
        year=1940,
        status=UnionStatus.ENDED,
    )

    saramma = make_person("Saramma", gender=F, birth=1928, house="Manalel")
    joseph = make_person("Joseph", gender=M, birth=1954, house=KAVUNKAL)
    lucy = make_person("Lucy", gender=F, birth=1957, house=KAVUNKAL)
    u_chacko_2 = make_union(
        chacko,
        saramma,
        children=[(joseph, RelationType.BIOLOGICAL, 1), (lucy, RelationType.BIOLOGICAL, 2)],
        year=1952,
        status=UnionStatus.ENDED,
    )

    # --- G2: Eliyamma's son, father never recorded -------------------------
    varkey = make_person("Varkey", gender=M, birth=1940, house=KAVUNKAL)
    u_eliyamma = make_union(eliyamma, children=[varkey], year=1939, union_type=UnionType.UNKNOWN)

    # --- G2: Devassy's household, with an adopted son ----------------------
    kunjamma = make_person("Kunjamma", gender=F, birth=1925, house="Kollamparambil")
    baby = make_person("Baby", gender=F, birth=1950, house=KAVUNKAL)
    ouseph = make_person("Ouseph", gender=M, birth=1952, house=KAVUNKAL)
    u_devassy = make_union(
        devassy,
        kunjamma,
        children=[(baby, RelationType.BIOLOGICAL, 1), (ouseph, RelationType.ADOPTED, 2)],
        year=1948,
    )

    # --- G3 ---------------------------------------------------------------
    gracy = make_person("Gracy", gender=F, birth=1948, house="Thundathil")
    jose = make_person("Jose", gender=M, birth=1970, house=KAVUNKAL)
    mini = make_person("Mini", gender=F, birth=1973, house=KAVUNKAL)
    u_thomas = make_union(
        thomas,
        gracy,
        children=[(jose, RelationType.BIOLOGICAL, 1), (mini, RelationType.BIOLOGICAL, 2)],
        year=1968,
    )

    molly = make_person("Molly", gender=F, birth=1958, house="Edathil", living=True)
    bibin = make_person("Bibin", gender=M, birth=1982, house=KAVUNKAL, living=True)
    u_joseph = make_union(joseph, molly, children=[bibin], year=1980)

    leelamma = make_person("Leelamma", gender=F, birth=1944, house="Karottu")
    sunil = make_person("Sunil", gender=M, birth=1968, house=KAVUNKAL, living=True)
    u_varkey = make_union(varkey, leelamma, children=[sunil], year=1966)

    kuruvilla = make_person("Kuruvilla", gender=M, birth=1946, house="Nedumparambil")
    deepa = make_person("Deepa", gender=F, birth=1975, house="Nedumparambil", living=True)
    u_baby = make_union(kuruvilla, baby, children=[deepa], year=1973)

    # --- G4 ---------------------------------------------------------------
    sheeba = make_person("Sheeba", gender=F, birth=1974, house="Vadakkel", living=True)
    arun = make_person("Arun", gender=M, birth=1998, house=KAVUNKAL, living=True)
    anju = make_person("Anju", gender=F, birth=2001, house=KAVUNKAL, living=True)
    u_jose = make_union(
        jose,
        sheeba,
        children=[(arun, RelationType.BIOLOGICAL, 1), (anju, RelationType.BIOLOGICAL, 2)],
        year=1996,
    )

    neethu = make_person("Neethu", gender=F, birth=1986, house="Chirayil", living=True)
    adithyan = make_person("Adithyan", gender=M, birth=2010, house=KAVUNKAL, living=True)
    u_bibin = make_union(bibin, neethu, children=[adithyan], year=2008)

    smitha = make_person("Smitha", gender=F, birth=1972, house="Panayil", living=True)
    nithin = make_person("Nithin", gender=M, birth=1996, house=KAVUNKAL, living=True)
    u_sunil = make_union(sunil, smitha, children=[nithin], year=1994)

    # --- G5 / G6 ----------------------------------------------------------
    riya = make_person("Riya", gender=F, birth=2000, house="Kizhakkethil", living=True)
    kiran = make_person("Kiran", gender=M, birth=2022, house=KAVUNKAL, living=True)
    u_arun = make_union(arun, riya, children=[kiran], year=2020)

    return SimpleNamespace(
        # G1
        ittira=ittira,
        mariam=mariam,
        # G2
        chacko=chacko,
        eliyamma=eliyamma,
        devassy=devassy,
        annamma=annamma,
        saramma=saramma,
        kunjamma=kunjamma,
        # G3
        thomas=thomas,
        rosy=rosy,
        joseph=joseph,
        lucy=lucy,
        varkey=varkey,
        baby=baby,
        ouseph=ouseph,
        gracy=gracy,
        molly=molly,
        leelamma=leelamma,
        kuruvilla=kuruvilla,
        # G4
        jose=jose,
        mini=mini,
        bibin=bibin,
        sunil=sunil,
        deepa=deepa,
        sheeba=sheeba,
        neethu=neethu,
        smitha=smitha,
        # G5
        arun=arun,
        anju=anju,
        adithyan=adithyan,
        nithin=nithin,
        riya=riya,
        # G6
        kiran=kiran,
        # unions
        u_g1=u_g1,
        u_chacko_1=u_chacko_1,
        u_chacko_2=u_chacko_2,
        u_eliyamma=u_eliyamma,
        u_devassy=u_devassy,
        u_thomas=u_thomas,
        u_joseph=u_joseph,
        u_varkey=u_varkey,
        u_baby=u_baby,
        u_jose=u_jose,
        u_bibin=u_bibin,
        u_sunil=u_sunil,
        u_arun=u_arun,
    )


def build_family_b() -> SimpleNamespace:
    """The fictional Palathinkal family — a separate component of the graph."""
    kesavan = make_person("Kesavan", gender=M, birth=1900, house=PALATHINKAL)
    bhargavi = make_person("Bhargavi", gender=F, birth=1905, house="Thekkedathu")
    raghavan = make_person("Raghavan", gender=M, birth=1930, house=PALATHINKAL)
    sarasu = make_person("Sarasu", gender=F, birth=1933, house=PALATHINKAL)
    u_g1 = make_union(
        kesavan,
        bhargavi,
        children=[(raghavan, RelationType.BIOLOGICAL, 1), (sarasu, RelationType.BIOLOGICAL, 2)],
        year=1928,
    )

    padmini = make_person("Padmini", gender=F, birth=1938, house="Ambalathil")
    manoj = make_person("Manoj", gender=M, birth=1960, house=PALATHINKAL, living=True)
    suja = make_person("Suja", gender=F, birth=1963, house=PALATHINKAL, living=True)
    u_raghavan = make_union(
        raghavan,
        padmini,
        children=[(manoj, RelationType.BIOLOGICAL, 1), (suja, RelationType.BIOLOGICAL, 2)],
        year=1958,
    )

    beena = make_person("Beena", gender=F, birth=1965, house="Puthiyaveedu", living=True)
    vishnu = make_person("Vishnu", gender=M, birth=1988, house=PALATHINKAL, living=True)
    athira = make_person("Athira", gender=F, birth=1990, house=PALATHINKAL, living=True)
    u_manoj = make_union(
        manoj,
        beena,
        children=[(vishnu, RelationType.BIOLOGICAL, 1), (athira, RelationType.BIOLOGICAL, 2)],
        year=1986,
    )

    return SimpleNamespace(
        kesavan=kesavan,
        bhargavi=bhargavi,
        raghavan=raghavan,
        sarasu=sarasu,
        padmini=padmini,
        manoj=manoj,
        suja=suja,
        beena=beena,
        vishnu=vishnu,
        athira=athira,
        u_g1=u_g1,
        u_raghavan=u_raghavan,
        u_manoj=u_manoj,
    )


def build_bridged_families() -> SimpleNamespace:
    """Both families, joined by a marriage — related by union, not by blood."""
    family_a = build_family_a()
    family_b = build_family_b()
    bridge = make_union(family_a.anju, family_b.vishnu, year=2024, status=UnionStatus.ACTIVE)
    return SimpleNamespace(a=family_a, b=family_b, bridge=bridge)


def build_duplicate_pair() -> SimpleNamespace:
    """The same fictional man entered twice by two different contributors.

    `primary` and `duplicate` are both recorded as children of the same union, which is
    what makes this a realistic merge target — and what forces the merge to handle the
    (union, person, role) uniqueness conflict rather than blindly repointing.
    """
    chandy = make_person("Chandy", gender=M, birth=1900, house=VAZHAKKUNNATHIL)
    thresia = make_person("Thresia", gender=F, birth=1904, house="Ottaplackal")
    sister = make_person("Aleyamma", gender=F, birth=1928, house=VAZHAKKUNNATHIL)

    primary = make_person(
        "Ouseph",
        gender=M,
        birth=1930,
        house=VAZHAKKUNNATHIL,
        nicknames=["Outha"],
        notes="Entered by contributor 1",
    )
    duplicate = make_person(
        "Yousef",
        gender=M,
        birth=1930,
        house=VAZHAKKUNNATHIL,
        name_ml="ഔസേഫ്",
        nicknames=["Ousepachan"],
        notes="Entered by contributor 2",
    )

    u_birth = make_union(
        chandy,
        thresia,
        children=[
            (sister, RelationType.BIOLOGICAL, 1),
            (primary, RelationType.BIOLOGICAL, 2),
            (duplicate, RelationType.BIOLOGICAL, 2),
        ],
        year=1926,
    )

    # Each contributor recorded a different half of his adult life.
    mariamma = make_person("Mariamma", gender=F, birth=1935, house="Kalathil")
    son = make_person("Jacob", gender=M, birth=1958, house=VAZHAKKUNNATHIL)
    u_primary = make_union(primary, mariamma, children=[son], year=1955)

    daughter = make_person("Annie", gender=F, birth=1961, house=VAZHAKKUNNATHIL)
    u_duplicate = make_union(
        duplicate, children=[daughter], year=1960, union_type=UnionType.UNKNOWN
    )

    return SimpleNamespace(
        primary=primary,
        duplicate=duplicate,
        chandy=chandy,
        thresia=thresia,
        sister=sister,
        mariamma=mariamma,
        son=son,
        daughter=daughter,
        u_birth=u_birth,
        u_primary=u_primary,
        u_duplicate=u_duplicate,
    )
