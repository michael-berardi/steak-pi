RATES = {"SAVE10": 0.10, "SAVE25": 0.25}

def calc_total(items, code=None):
    subtotal = sum(p * q for _, p, q in items)
    rate = RATES.get(code, 0)
    total = subtotal - subtotal * rate
    total = total - total * rate
    return round(total, 2)
