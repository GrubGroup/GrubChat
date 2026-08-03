"""Cuisine-group + restaurant-style taxonomy for the QA sub-agent.

The QA preference agent lets a diner speak in *arbitrary* terms — "Asian food",
"something Latin", "a nice steakhouse", "grab a bbq joint" — instead of picking
from a fixed menu. This module turns those loose terms into the concrete,
retrieval-matchable cuisine tags the rest of the pipeline already understands.

Two vocabularies live here:

  * **Cuisine groups** — broad cultural umbrellas ("asian", "latin_american",
    "mediterranean", ...) that each *expand* into the specific member cuisines
    under them. Saying "Asian food" should weight chinese/japanese/thai/... all
    at once. This is the "group multiple cultural foods into one" behavior.
  * **Restaurant styles** — the *kind* of place ("barbecue", "fast_food",
    "seafood", "fine_dining", "cafe", "steakhouse", "pub_bar", ...). These are
    recorded alongside cuisines in ``preferred_cuisines`` (the schema has no
    separate style column), so a style term also expands to any catalog aliases.

**Tag format is lowercase and single-concept, but the SEPARATOR differs by column:**

  * ``cuisine_tags`` — UNDERSCORE (``fine_dining``, ``middle_eastern``).
  * ``dietary_tags`` — HYPHEN (``gluten-free``, ``nut-free``), because that
    controlled vocabulary is owned by the gateway's Prisma seed
    (``backend/gateway/prisma/seed.mjs``), which is what populated the live
    database. See the note above ``DIETARY_SYNONYMS`` — getting this wrong
    silently empties the recommendation set, since dietary is the one HARD filter.

Where a canonical key differs from the catalog's tag (style ``barbecue`` vs
``bbq``; group ``latin_american`` vs ``latin``), the expansion emits BOTH so the
recorded tags land on real restaurants.

Note that ``scripts/seed_restaurants.py`` (the older embedded Python catalog)
writes the underscore form for dietary tags and so disagrees with the live data;
the gateway seed is authoritative.

Expansion is **soft**: cuisine tags are a preference weight, never a hard filter
(only dietary tags hard-filter), so an expanded tag with no matching restaurant
is a harmless no-op. That is what makes it safe to expand one broad word into a
dozen member tags.

This module is pure data + pure functions (no I/O, no LLM) so it is trivially
importable by ``app/ai/llm/prompts.py`` (to document the vocabulary in the
system prompt), ``app/ai/agents/conversation_agent.py`` (to expand parsed
terms), and the ``scripts/`` demos — all via the project's absolute
``app.ai.taxonomy`` import style.
"""

from __future__ import annotations

from collections.abc import Iterable

__all__ = [
    "CUISINE_GROUPS",
    "RESTAURANT_STYLES",
    "DIETARY_SYNONYMS",
    "PROMPT_CUISINE_GROUP_CATALOG",
    "PROMPT_STYLE_CATALOG",
    "normalize_tag",
    "expand_cuisine_terms",
    "expand_group_terms_only",
    "compact_cuisine_terms",
    "normalize_dietary_terms",
]


def normalize_tag(value: str) -> str:
    """Coerce a raw term to lower_snake, single concept — the LOOKUP key form.

    Collapses spaces and hyphens to a single underscore so "gluten free",
    "gluten-free", and "Gluten  Free" all reduce to one key (``gluten_free``).
    That makes it the right normalizer for cuisine tags, which are stored
    underscored, and the right first step for dietary terms — but NOT the final
    form for them: ``normalize_dietary_terms`` maps the key onto the hyphenated
    tag the ``dietary_tags`` column actually stores. Don't use this alone on a
    dietary term.
    """
    return "_".join(str(value).strip().lower().replace("-", " ").split())


# ---------------------------------------------------------------------------
# Cuisine groups — a broad cultural umbrella -> the member cuisines under it.
#
# `members` are the specific cuisines the group expands into (underscore tags).
# `seed_umbrella` are catalog tags that are themselves the broad group (e.g. the
# seed uses "asian", "latin", "middle_eastern", "mediterranean", "american" as
# real cuisine_tags) — emitted alongside members so a restaurant tagged only with
# the umbrella still matches. `synonyms` are recognition-only: the loose words a
# diner might say for this group; they are never emitted as tags.
#
# Overlap is intentional: Mediterranean shares italian/turkish/lebanese/spanish/
# moroccan with European and Middle Eastern because those cuisines genuinely
# straddle the regions.
# ---------------------------------------------------------------------------

CUISINE_GROUPS: dict[str, dict[str, list[str]]] = {
    "asian": {
        "label": ["Asian"],
        "seed_umbrella": ["asian"],
        "members": [
            "chinese", "japanese", "korean", "thai", "vietnamese", "indian",
            "indonesian", "malaysian", "filipino", "mongolian", "taiwanese",
            "singaporean", "sri_lankan", "nepali", "cantonese", "dim_sum",
            "ramen", "sushi", "noodles", "tibetan",
        ],
        "synonyms": [
            "asian_food", "east_asian", "southeast_asian", "south_asian",
            "pan_asian", "asian_fusion",
        ],
    },
    "european": {
        "label": ["European"],
        "seed_umbrella": [],
        "members": [
            "italian", "french", "spanish", "german", "portuguese", "british",
            "irish", "polish", "russian", "swiss", "scandinavian", "hungarian",
            "roman", "pasta", "pizza", "bistro",
        ],
        "synonyms": ["european_food", "continental", "continental_european"],
    },
    "latin_american": {
        "label": ["Latin American"],
        "seed_umbrella": ["latin"],
        "members": [
            "mexican", "brazilian", "peruvian", "argentinian", "cuban",
            "colombian", "venezuelan", "chilean", "caribbean", "tex_mex",
            "tacos",
        ],
        "synonyms": [
            "latin", "latino", "latin_food", "hispanic", "south_american",
            "central_american", "latin_america",
        ],
    },
    "middle_eastern": {
        "label": ["Middle Eastern"],
        "seed_umbrella": ["middle_eastern"],
        "members": [
            "lebanese", "turkish", "persian", "israeli", "syrian", "iraqi",
            "yemeni", "moroccan",
        ],
        "synonyms": [
            "middle_east", "mideast", "arab", "arabic", "levantine",
            "mediterranean_middle_eastern",
        ],
    },
    "african": {
        "label": ["African"],
        "seed_umbrella": [],
        "members": [
            "ethiopian", "nigerian", "south_african", "moroccan", "senegalese",
            "kenyan", "ghanaian",
        ],
        "synonyms": ["african_food", "west_african", "east_african", "north_african"],
    },
    "american": {
        "label": ["American"],
        "seed_umbrella": ["american"],
        "members": [
            "southern", "cajun", "tex_mex", "hawaiian", "soul_food",
            "new_american", "classic_american", "diner", "burgers", "bbq",
        ],
        "synonyms": ["american_food", "classic_american_food", "comfort_food"],
    },
    "mediterranean": {
        "label": ["Mediterranean"],
        "seed_umbrella": ["mediterranean"],
        "members": [
            "greek", "italian", "turkish", "lebanese", "spanish", "moroccan",
        ],
        "synonyms": ["med", "mediterranean_food"],
    },
}


# ---------------------------------------------------------------------------
# Restaurant styles — the KIND of place, recorded alongside cuisines.
#
# `seed_aliases` are catalog cuisine_tags that mean the same style but differ
# from the canonical key (style "barbecue" -> seed "bbq"; "food_truck" -> seed
# "street_food"). The canonical key AND its seed aliases are both emitted so the
# recorded tag matches real restaurants. `synonyms` are recognition-only loose
# words a diner might say; they are never emitted.
# ---------------------------------------------------------------------------

RESTAURANT_STYLES: dict[str, dict[str, list[str]]] = {
    "barbecue": {
        "seed_aliases": ["bbq", "grill"],
        "synonyms": ["bbq", "smokehouse", "grill", "ribs", "brisket", "barbeque", "bar_b_que"],
    },
    "fast_food": {
        "seed_aliases": ["fast_casual", "burgers"],
        "synonyms": ["fastfood", "quick_service", "drive_thru", "burger_joint", "quick_bite"],
    },
    "seafood": {
        "seed_aliases": ["seafood", "raw_bar", "sushi"],
        "synonyms": ["fish", "shellfish", "sushi_bar", "oyster_bar", "crab_shack"],
    },
    "fine_dining": {
        "seed_aliases": ["fine_dining", "kaiseki"],
        "synonyms": ["upscale", "high_end", "michelin", "tasting_menu", "gourmet", "fancy"],
    },
    "bakery": {
        "seed_aliases": ["bakery"],
        "synonyms": ["patisserie", "bread_shop", "pastry", "donut_shop"],
    },
    "cafe": {
        "seed_aliases": ["cafe"],
        "synonyms": ["coffee_shop", "coffeehouse", "espresso_bar", "tea_house", "coffee"],
    },
    "buffet": {
        "seed_aliases": [],
        "synonyms": ["all_you_can_eat", "smorgasbord", "buffet_style"],
    },
    "food_truck": {
        "seed_aliases": ["street_food"],
        "synonyms": ["street_food", "mobile_kitchen", "cart", "food_cart"],
    },
    "steakhouse": {
        "seed_aliases": ["steakhouse", "grill"],
        "synonyms": ["chophouse", "grill_house", "steak", "steaks", "steak_house"],
    },
    "vegetarian_vegan": {
        "seed_aliases": ["vegetarian", "vegan"],
        "synonyms": ["plant_based", "veggie", "vegan_spot", "meatless"],
    },
    "dessert": {
        "seed_aliases": ["dessert"],
        "synonyms": ["ice_cream", "sweets", "candy_shop", "gelato", "desserts"],
    },
    "brunch": {
        "seed_aliases": ["brunch", "diner"],
        "synonyms": ["breakfast_spot", "breakfast", "diner"],
    },
    "pizza": {
        "seed_aliases": ["pizza"],
        "synonyms": ["pizzeria", "pizza_shop", "pizzas"],
    },
    "sandwich_deli": {
        "seed_aliases": ["deli", "sandwiches"],
        "synonyms": ["sub_shop", "deli", "sandwich_shop", "sandwich", "subs"],
    },
    "pub_bar": {
        "seed_aliases": ["bar", "gastropub"],
        "synonyms": ["gastropub", "tavern", "sports_bar", "brewery", "pub", "bar"],
    },
}


# ---------------------------------------------------------------------------
# Dietary synonyms -> the six controlled dietary tags the seed catalog carries.
# Group/style expansion never touches dietary_restrictions (there is no dietary
# "group"); this map only normalizes loose phrasings onto the controlled six so
# a durable Profile write from the /analyze turn stays matchable.
# ---------------------------------------------------------------------------

# NOTE ON SEPARATORS — dietary tags are HYPHENATED, cuisines are underscored.
# This asymmetry is not a typo. `dietary_tags` is a controlled vocabulary owned by
# the gateway's Prisma seed (backend/gateway/prisma/seed.mjs), which declares it as
# 'vegan' | 'vegetarian' | 'gluten-free' | 'nut-free' | 'dairy-free' | 'halal' |
# 'kosher' | 'shellfish-free' — with HYPHENS — and that seed is what populated the
# live database (0 underscore-form dietary tags exist there).
#
# It matters far more than a cosmetic mismatch because `dietary_tags` is the one
# HARD filter: ai/rag/retriever.similarity_search pushes `dietary_tags @>
# required` into SQL. Emitting `gluten_free` against rows that say `gluten-free`
# satisfies the superset test for ZERO rows, so a gluten-free or nut-free member
# silently received NO recommendations at all (verified: `['gluten_free']` -> 0
# candidates, `['gluten-free']` -> 20). Only these two of the six controlled tags
# are multi-word, which is why the bug hid.
#
# Cuisine tags stay underscored (`middle_eastern`, `fine_dining`) — they are a
# soft preference weight, so a near-miss loses a little signal instead of emptying
# the result set.
DIETARY_SYNONYMS: dict[str, str] = {
    "veggie": "vegetarian",
    "meatless": "vegetarian",
    "plant_based": "vegan",
    "no_gluten": "gluten-free",
    "gluten_free": "gluten-free",
    "glutenfree": "gluten-free",
    "celiac": "gluten-free",
    "coeliac": "gluten-free",
    "gf": "gluten-free",
    "no_nuts": "nut-free",
    "nut_free": "nut-free",
    "nut_allergy": "nut-free",
    "peanut_free": "nut-free",
    "tree_nut_free": "nut-free",
    # Also in the gateway's controlled vocabulary and present on live rows, so
    # accept the loose phrasings a diner actually says for them.
    "dairy_free": "dairy-free",
    "no_dairy": "dairy-free",
    "lactose_free": "dairy-free",
    "lactose_intolerant": "dairy-free",
    "shellfish_free": "shellfish-free",
    "no_shellfish": "shellfish-free",
    "shellfish_allergy": "shellfish-free",
}



# ---------------------------------------------------------------------------
# Reverse alias index (built once at import): every recognizable term (canonical
# key + synonyms) -> the ordered list of tags it expands to. Group MEMBERS are
# never registered as GROUP recognition keys — a specific cuisine like "thai"
# stays specific and never re-triggers its whole cuisine group. A few member
# words ("bbq", "diner", "pizza") DO coincide with style keys/synonyms, so they
# are recognized as STYLE terms by design and expand to the parallel style set
# (e.g. "bbq" -> barbecue/bbq/grill), never to their cuisine group. Groups win
# over styles on any key collision (setdefault below preserves the group entry).
# ---------------------------------------------------------------------------


def _dedupe(tags: Iterable[str]) -> list[str]:
    """Order-preserving de-duplication, dropping empties."""
    out: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if tag and tag not in seen:
            seen.add(tag)
            out.append(tag)
    return out


def _build_alias_index() -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}

    for key, group in CUISINE_GROUPS.items():
        expansion = _dedupe(
            [key, *group["seed_umbrella"], *group["members"]]
        )
        for alias in {key, *group["synonyms"]}:
            index[normalize_tag(alias)] = expansion

    for key, style in RESTAURANT_STYLES.items():
        expansion = _dedupe([key, *style["seed_aliases"]])
        # Styles never clobber a cuisine-group alias if one collides — groups win
        # (a broad cuisine request is the stronger intent). setdefault preserves
        # any group expansion already registered for the same word.
        for alias in {key, *style["synonyms"]}:
            index.setdefault(normalize_tag(alias), expansion)

    return index


def _build_group_alias_index() -> dict[str, list[str]]:
    """Reverse index of cuisine-GROUP aliases only (no styles).

    Used by removal expansion: dropping a whole cuisine group ("no asian") should
    cascade to its members, but dropping a STYLE ("no seafood") must NOT expand,
    because some style seed_aliases are standalone cuisine tags a user may still
    want independently (e.g. seafood -> sushi, steakhouse -> grill, brunch ->
    diner). Restricting removal expansion to groups keeps "no seafood" from
    silently deleting a separately-liked "sushi".
    """
    index: dict[str, list[str]] = {}
    for key, group in CUISINE_GROUPS.items():
        expansion = _dedupe([key, *group["seed_umbrella"], *group["members"]])
        for alias in {key, *group["synonyms"]}:
            index[normalize_tag(alias)] = expansion
    return index


_ALIAS_TO_EXPANSION: dict[str, list[str]] = _build_alias_index()
_GROUP_ALIAS_TO_EXPANSION: dict[str, list[str]] = _build_group_alias_index()

# group_key -> the set of its MEMBER cuisines (for the compaction fraction test).
_GROUP_MEMBER_SETS: dict[str, frozenset[str]] = {
    key: frozenset(normalize_tag(m) for m in group["members"])
    for key, group in CUISINE_GROUPS.items()
}
# group_key -> its FULL read-time expansion (key + seed_umbrella + members), the
# tags a stored key covers so they're redundant to also store explicitly.
_GROUP_FULL_EXPANSION: dict[str, frozenset[str]] = {
    key: frozenset(_ALIAS_TO_EXPANSION[key]) for key in CUISINE_GROUPS
}

# A stored cuisine list collapses a group's members back to its single group key
# once this fraction of the group's members are present — so the stored/echoed
# form stays small (the analyze turn is output-token-bound, ~13 ms/token, and a
# 21-tag echo measured ~+286 ms/turn vs a 3-tag one). Below the threshold a
# handful of named cuisines is NOT a whole-group ask and is kept specific.
_COMPACT_GROUP_THRESHOLD = 0.7


def compact_cuisine_terms(
    tags: Iterable[str], *, blocked: Iterable[str] = ()
) -> list[str]:
    """Collapse a group's member cuisines back to its single group key.

    The inverse-in-spirit of ``expand_cuisine_terms`` and the storage-side half of
    the compact-signal latency fix: the analyze turn stores/echoes COMPACT group
    keys, and ``orchestrator_agent._reconcile`` re-expands them at read time. A
    group collapses to its key when the list already holds the key (redundant
    members are dropped) OR is saturated with the group's members (fraction >=
    ``_COMPACT_GROUP_THRESHOLD``). Because the key re-expands to the FULL member
    set at read, collapsing is INTENT-lossless: it can only restore members the
    model dropped from a whole-group answer ("asian food"), never invent a group
    the user didn't broadly ask for (a lone "chinese" is 1/20, far below the bar).

    ``blocked`` is the OPPOSITE like/dislike list (already reconciled): a group is
    NOT collapsed if its expansion overlaps a blocked tag, because re-expanding it
    at read would re-introduce a cuisine the user just moved to the other side —
    which would cancel the orchestrator's +/- weights to zero. This keeps a
    like/dislike FLIP that removed one member from a group stored as the explicit
    remaining members rather than snapping back to the umbrella key.
    """
    norm = _dedupe(normalize_tag(t) for t in tags if t)
    present = set(norm)
    blocked_expanded = set(expand_cuisine_terms(blocked)) if blocked else set()

    keys_to_add: list[str] = []
    covered: set[str] = set()
    for key, members in _GROUP_MEMBER_SETS.items():
        full = _GROUP_FULL_EXPANSION[key]
        key_present = bool(present & full & ({key} | set(CUISINE_GROUPS[key]["seed_umbrella"])))
        saturated = bool(members) and len(present & members) / len(members) >= _COMPACT_GROUP_THRESHOLD
        if not (key_present or saturated):
            continue
        if full & blocked_expanded:
            continue  # collapsing would re-introduce an opposite-list cuisine
        keys_to_add.append(key)
        covered |= full

    if not keys_to_add:
        return norm
    kept = [t for t in norm if t not in covered]
    return _dedupe([*keys_to_add, *kept])


def expand_group_terms_only(tags: Iterable[str]) -> list[str]:
    """Expand only cuisine-GROUP umbrella terms; styles + specifics pass through.

    The removal-side counterpart to expand_cuisine_terms: a group term ("asian")
    cascades to its members so a whole-group removal drops them all, while a style
    term ("seafood") or a specific cuisine ("sushi") is taken literally so it can
    only remove itself — never a standalone tag that shares a style's alias.
    """
    result: list[str] = []
    for raw in tags:
        tag = normalize_tag(raw)
        if not tag:
            continue
        result.extend(_GROUP_ALIAS_TO_EXPANSION.get(tag, [tag]))
    return _dedupe(result)


def expand_cuisine_terms(tags: Iterable[str]) -> list[str]:
    """Expand group/style umbrella terms into concrete, matchable cuisine tags.

    Each incoming tag is normalized, then:
      * a recognized cuisine-group term ("asian", "latin", "mediterranean", ...)
        expands to the umbrella + every member cuisine under it;
      * a recognized restaurant-style term ("barbecue", "food_truck", ...)
        expands to the canonical style key + its seed-catalog aliases;
      * anything else (a specific cuisine like "thai", or an unknown word) passes
        through unchanged.
    The result is order-preserving and de-duplicated, so expanding
    ["asian", "thai", "steakhouse"] yields the asian set (with thai already in
    it, not duplicated) followed by steakhouse's tags.
    """
    result: list[str] = []
    for raw in tags:
        tag = normalize_tag(raw)
        if not tag:
            continue
        result.extend(_ALIAS_TO_EXPANSION.get(tag, [tag]))
    return _dedupe(result)


def normalize_dietary_terms(tags: Iterable[str]) -> list[str]:
    """Map loose dietary phrasings onto the controlled HYPHENATED dietary tags.

    Order-kept. Note the two-step: ``normalize_tag`` first collapses hyphens and
    spaces to underscores (so "gluten free", "Gluten-Free", and "gluten_free" all
    become the same lookup key), and DIETARY_SYNONYMS then maps that key to the
    hyphenated form the live ``dietary_tags`` column actually stores. Doing it in
    this order is what makes every phrasing land on one canonical tag.

    An unknown multi-word term therefore leaves here underscored and will match
    nothing — a safe no-op against the retriever's superset filter for a *cuisine*
    weight, but for a dietary term it is a silent empty result set, so new entries
    in the gateway's controlled vocabulary must be added to DIETARY_SYNONYMS.
    """
    result: list[str] = []
    for raw in tags:
        tag = normalize_tag(raw)
        if not tag:
            continue
        result.append(DIETARY_SYNONYMS.get(tag, tag))
    return _dedupe(result)


# ---------------------------------------------------------------------------
# Prompt-facing catalog strings (single source of truth for the system prompt).
# Built from the data above so the prompt never drifts from the expansion logic.
# ---------------------------------------------------------------------------


def _build_group_catalog() -> str:
    lines: list[str] = []
    for key, group in CUISINE_GROUPS.items():
        members = ", ".join(group["members"])
        lines.append(f"  {key} => {members}")
    return "\n".join(lines)


def _build_style_catalog() -> str:
    lines: list[str] = []
    for key, style in RESTAURANT_STYLES.items():
        hints = ", ".join(style["synonyms"][:4])
        lines.append(f"  {key} (e.g. {hints})" if hints else f"  {key}")
    return "\n".join(lines)


PROMPT_CUISINE_GROUP_CATALOG: str = _build_group_catalog()
PROMPT_STYLE_CATALOG: str = _build_style_catalog()
