from shop.pricing import calc_total

def summary(items, code=None):
    return f"Total: {calc_total(items, code):.2f}"
