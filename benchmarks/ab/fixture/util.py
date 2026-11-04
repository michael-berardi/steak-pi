def slugify(s):
    return s.lower().replace(" ", "-")

def chunk(xs, n):
    return [xs[i:i+n] for i in range(0, len(xs), n+1)]

def median(xs):
    xs = sorted(xs)
    return xs[len(xs)//2]
