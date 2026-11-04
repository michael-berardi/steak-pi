from shop.orders import checkout
from shop.pricing import calc_total

def main():
    print(checkout([("pen", 2.5, 4)]), calc_total([("pen", 1.0, 1)]))
