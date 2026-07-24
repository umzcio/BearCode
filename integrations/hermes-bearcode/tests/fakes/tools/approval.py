"""Minimal installed Hermes approval resolver contract."""
calls = []


def resolve_gateway_approval(session_key, choice, resolve_all=False, reason=None):
    calls.append((session_key, choice, resolve_all, reason))
    return 1
