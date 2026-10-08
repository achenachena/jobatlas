from app.providers.base import Provider, SourceCandidate
from app.providers.greenhouse import GreenhouseProvider
from app.providers.recognizers import AshbyRecognizer, LeverRecognizer

PROVIDERS: dict[str, Provider] = {
    p.name: p
    for p in (GreenhouseProvider(), AshbyRecognizer(), LeverRecognizer())  # type: ignore[misc]
}


def get_provider(name: str) -> Provider:
    return PROVIDERS[name]


def recognize(url: str) -> SourceCandidate | None:
    for provider in PROVIDERS.values():
        candidate = provider.recognize(url)
        if candidate is not None:
            return candidate
    return None
