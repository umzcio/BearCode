"""Minimal installed Hermes configuration contract."""
from enum import Enum


class Platform(Enum):
    LOCAL = "local"

    @classmethod
    def _missing_(cls, value):
        member = object.__new__(cls)
        member._name_ = str(value).upper()
        member._value_ = str(value)
        cls._value2member_map_[value] = member
        return member
