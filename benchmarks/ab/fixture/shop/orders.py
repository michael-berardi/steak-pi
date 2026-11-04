from shop.pricing import calc_total

def checkout(items, code=None):
    """items: list of (name, unit_price, qty)."""
    return calc_total(items, code)
