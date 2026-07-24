"""Minimal installed Hermes clarification resolver contract."""
calls = []


def resolve_gateway_clarify(clarify_id, response):
    calls.append((clarify_id, response))
    return True
