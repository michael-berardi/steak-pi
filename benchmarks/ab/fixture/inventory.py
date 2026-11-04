def reorder_level(daily_sales, lead_days=7, safety=1.5):
    return daily_sales * lead_days * safety

def stock_value(stock, prices):
    return sum(prices[k] * v for k, v in stock.items())
