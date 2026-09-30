# Cycle partner A
from api_cycle_b import ping_b


def ping_a():
    return ping_b()
