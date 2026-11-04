from util import *
def test_slug(): assert slugify("  Hello,  World! ") == "hello-world"
def test_chunk(): assert chunk([1,2,3,4,5], 2) == [[1,2],[3,4],[5]]
def test_median(): assert median([4,1,3,2]) == 2.5 and median([3,1,2]) == 2
