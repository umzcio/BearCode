"""Minimal installed Hermes session-key contract."""
from dataclasses import dataclass
from typing import Optional

from gateway.config import Platform


@dataclass
class SessionSource:
    platform: Platform
    chat_id: str
    chat_name: Optional[str] = None
    chat_type: str = "dm"
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    thread_id: Optional[str] = None
    message_id: Optional[str] = None
    role_authorized: bool = False
    profile: Optional[str] = None


def build_session_key(
    source,
    group_sessions_per_user=True,
    thread_sessions_per_user=False,
    profile=None,
):
    del group_sessions_per_user, thread_sessions_per_user
    namespace = "agent:main" if not profile or profile == "default" else f"agent:{profile}"
    if source.chat_type == "dm":
        if source.chat_id:
            if source.thread_id:
                return (
                    f"{namespace}:{source.platform.value}:dm:"
                    f"{source.chat_id}:{source.thread_id}"
                )
            return f"{namespace}:{source.platform.value}:dm:{source.chat_id}"
        if source.user_id:
            return f"{namespace}:{source.platform.value}:dm:{source.user_id}"
        return f"{namespace}:{source.platform.value}:dm"
    parts = [namespace, source.platform.value, source.chat_type]
    if source.chat_id:
        parts.append(source.chat_id)
    if source.thread_id:
        parts.append(source.thread_id)
    return ":".join(parts)
