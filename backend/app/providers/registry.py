from app.providers.ashby import AshbyProvider
from app.providers.base import Provider, SourceCandidate
from app.providers.greenhouse import GreenhouseProvider
from app.providers.jsonld import JsonLdProvider
from app.providers.lever import LeverProvider

PROVIDERS: dict[str, Provider] = {
    p.name: p  # type: ignore[misc]
    for p in (GreenhouseProvider(), AshbyProvider(), LeverProvider(), JsonLdProvider())
}


def get_provider(name: str) -> Provider:
    return PROVIDERS[name]


def recognize(url: str) -> SourceCandidate | None:
    for provider in PROVIDERS.values():
        candidate = provider.recognize(url)
        if candidate is not None:
            return candidate
    return None
