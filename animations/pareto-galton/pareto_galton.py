"""
A Galton board for the Pareto curve: a 3Blue1Brown-style explainer in Manim.

Render one scene:   manim -qh --fps 30 pareto_galton.py S2Classic
Render everything:  see render.sh (renders each scene, then joins them with ffmpeg)

Scenes, in order:
  S1Open       cold open: photo of a real Galton board -> its bell curve -> long tail, title
  S2Classic    the classic Galton board, one path, Pascal's triangle, 400 balls
  S3Gauss      more rows -> the Gaussian; formula, 68/95, thin tails, CLT
  S4Pareto     long tails in the world; P(X>=x)=x^-a; doubling; 80/20; log-log
  S5Board      adding vs surviving; one stage + knife at the median; the staircase;
               1,000 balls; bin labels b^k; the derivation; the log-log check
  S6Close      adding -> Gaussian, surviving -> Pareto; end card
"""
from manim import *
import numpy as np
import math, json, os

from PIL import Image
from scipy.spatial.distance import pdist


def _display_image_mobject(self, image_mobject, pixel_array):
    """Manim 0.19's Camera.display_image_mobject, fixed for Pillow >= 13.

    The original builds its blank canvas with Image.fromarray(np.zeros((h, w)), mode="RGBA"),
    which newer Pillow rejects ("Invalid mode for data type"). Image.new does the same job.
    """
    ul, ur, dl, _ = self.points_to_pixel_coords(image_mobject, image_mobject.points)
    right_vect, down_vect = ur - ul, dl - ul
    center = ul + (right_vect + down_vect) / 2
    sub = Image.fromarray(image_mobject.get_pixel_array(), mode="RGBA")
    w = max(int(pdist([ul, ur]).item()), 1)
    h = max(int(pdist([ul, dl]).item()), 1)
    sub = sub.resize((w, h), resample=image_mobject.resampling_algorithm)
    angle = -int(360 * angle_of_vector(right_vect) / TAU)
    if angle != 0:
        sub = sub.rotate(angle, resample=image_mobject.resampling_algorithm, expand=1)
    full = Image.new("RGBA", (self.pixel_width, self.pixel_height))
    x0, y0 = (center - np.array(sub.size) / 2).astype(int)
    full.paste(sub, box=(x0, y0, x0 + sub.size[0], y0 + sub.size[1]))
    self.overlay_PIL_image(pixel_array, full)


Camera.display_image_mobject = _display_image_mobject

config.background_color = "#0b0d11"
FONT = "Latin Modern Roman"

BALL = "#58C4DD"        # 3b1b blue
GAUSS = "#58C4DD"
PARETO = "#F4C542"      # warm gold for the long tail
KNIFE = "#FC6255"
PHOTO_RED = "#CC2522"   # the curve drawn on the real board in galton_board.jpg
PEG = "#8A8F98"
WALL = "#C9CDD4"
MUTED = "#9AA0A9"

ALPHA = 1.16
BASE = 2 ** (1 / ALPHA)          # 1.818...

MARKS = {}


def T(s, size=36, color=WHITE, **kw):
    return Text(s, font=FONT, font_size=size, color=color, **kw)


def mark(scene, key):
    """Record the time of a narration beat (seconds from the start of the scene)."""
    name = type(scene).__name__
    MARKS.setdefault(name, {})[key] = round(scene.renderer.time, 2)
    with open(f"marks_{name}.json", "w") as f:
        json.dump(MARKS[name], f, indent=1)


# ----------------------------------------------------------------------------- motion helpers
def seg(ta, tb, p0, p1, bump=0.0, ease="lin"):
    return (ta, tb, np.array(p0, float), np.array(p1, float), bump, ease)


def seg_pos(s, t):
    ta, tb, p0, p1, bump, ease = s
    u = 0 if tb <= ta else min(max((t - ta) / (tb - ta), 0), 1)
    if ease == "fall":
        v = u * u
    elif ease == "smooth":
        v = u * u * (3 - 2 * u)
    else:
        v = u
    p = p0 + (p1 - p0) * v
    p[1] += bump * 4 * u * (1 - u)
    return p


class Rain:
    """Moves a pool of dots along precomputed paths; landed balls become static dots."""

    def __init__(self, balls, r, color=BALL, land_color=None):
        self.balls = sorted(balls, key=lambda b: b["segs"][0][0])
        self.r = r
        self.color = color
        self.land_color = land_color or color
        # maximum number of balls in flight at once
        ev = []
        for b in self.balls:
            ev += [(b["segs"][0][0], 1), (b["t1"], -1)]
        ev.sort()
        c = m = 0
        for _, d in ev:
            c += d
            m = max(m, c)
        self.pool = VGroup(*[Dot(radius=r, color=color, fill_opacity=0) for _ in range(m + 2)])
        self.landed = VGroup()
        self.ptr = 0
        self.active = []
        self.counts = {}

    def update(self, t):
        while self.ptr < len(self.balls) and self.balls[self.ptr]["segs"][0][0] <= t:
            self.active.append(self.balls[self.ptr])
            self.ptr += 1
        still = []
        for b in self.active:
            if t >= b["t1"]:
                self.landed.add(Dot(b["slot"], radius=self.r, color=self.land_color))
                self.counts[b["bin"]] = self.counts.get(b["bin"], 0) + 1
            else:
                still.append(b)
        self.active = still
        for i, d in enumerate(self.pool):
            if i < len(self.active):
                b = self.active[i]
                s = next((s for s in b["segs"] if s[0] <= t < s[1]), b["segs"][-1])
                d.move_to(seg_pos(s, t))
                d.set_fill(opacity=1)
            else:
                d.set_fill(opacity=0)

    def play(self, scene, duration, extra=()):
        tr = ValueTracker(0)
        holder = VGroup(self.landed, self.pool)
        holder.add_updater(lambda m: self.update(tr.get_value()))
        scene.add(holder)
        scene.play(tr.animate.set_value(duration), *extra, run_time=duration, rate_func=linear)
        self.update(duration + 100)
        holder.clear_updaters()
        return holder


def stack_slot(n, left, right, floor, r, gap=0.0):
    """Position of the n-th ball in a bin, packed in alternating offset rows."""
    w = right - left - 2 * gap
    cols = max(int(w // (2 * r)), 1)
    row, col = divmod(n, cols)
    off = r if row % 2 else 0
    if row % 2 and col == cols - 1:
        off = 0
    x = left + gap + r + col * 2 * r + off
    y = floor + r + row * 2 * r * 0.88
    return np.array([x, y, 0])


# ----------------------------------------------------------------------------- a Galton board
class Board:
    def __init__(self, n, dx, dy, top, peg_r, ball_r):
        self.n, self.dx, self.dy = n, dx, dy
        self.top = np.array(top, float)
        self.peg_r, self.ball_r = peg_r, ball_r

    def peg(self, i, j):
        return self.top + np.array([(j - i / 2) * self.dx, -i * self.dy, 0])

    def on(self, i, j):
        return self.peg(i, j) + np.array([0, self.peg_r + self.ball_r, 0])

    def exit_pt(self, m):
        return self.top + np.array([(m - self.n / 2) * self.dx, -self.n * self.dy + self.ball_r, 0])

    def pegs(self, color=PEG):
        return VGroup(*[Dot(self.peg(i, j), radius=self.peg_r, color=color)
                        for i in range(self.n) for j in range(i + 1)])

    def path(self, choices, t0, hop, start=None):
        """choices: list of 0/1 (left/right). Returns segments, end time, final m."""
        segs = []
        t = t0
        p = self.on(0, 0)
        if start is not None:
            segs.append(seg(t, t + hop * 0.9, start, p, 0, "fall"))
            t += hop * 0.9
        j = 0
        for i in range(self.n):
            j2 = j + choices[i]
            q = self.on(i + 1, j2) if i + 1 < self.n else self.exit_pt(j2)
            segs.append(seg(t, t + hop, p, q, self.dy * 0.35))
            t += hop
            p, j = q, j2
        return segs, t, j


rng = np.random.default_rng(11)


# ============================================================================= scene 1
class S1Open(Scene):
    def construct(self):
        # The photo is 1500x1500 px and fills the frame height (8 units).
        img_px = 1500
        photo = ImageMobject(os.path.join(os.path.dirname(os.path.abspath(__file__)), "galton_board.jpg"))
        photo.set_height(config.frame_height)

        def px(x, y):
            return np.array([(x - img_px / 2) * config.frame_height / img_px,
                             (img_px / 2 - y) * config.frame_height / img_px, 0])

        # The red curve drawn on the board, fitted to the photo's pixels (RMS error ~2.5 px).
        def red_y(x):
            return 1172.04 + 0.00489 * (x - 750) - 272.3 * math.exp(-(x - 736) ** 2 / (2 * 127.5 ** 2))

        photo_curve = VMobject(stroke_color=PHOTO_RED, stroke_width=6.4)
        photo_curve.set_points_smoothly([px(x, red_y(x)) for x in np.linspace(346, 1132, 60)])

        mark(self, "N1")
        self.play(FadeIn(photo), FadeIn(photo_curve), run_time=1.2)
        self.play(photo.animate.scale(1.06), photo_curve.animate.scale(1.06, about_point=ORIGIN),
                  run_time=9.5, rate_func=linear)

        # Peel the photo away, leaving its curve behind in the video's style.
        ax = Axes(x_range=[-4, 4], y_range=[0, 1.1], x_length=9, y_length=4.2,
                  axis_config={"color": GREY_C, "include_ticks": False}).shift(DOWN * 0.6)
        ax.y_axis.set_opacity(0)
        bell = ax.plot(lambda x: math.exp(-x * x / 2), color=GAUSS, stroke_width=6)
        bell_fill = ax.get_area(bell, x_range=[-4, 4], color=GAUSS, opacity=0.25)
        mark(self, "N1a")
        self.play(FadeOut(photo, run_time=2.0), ReplacementTransform(photo_curve, bell, run_time=2.6))
        self.play(Create(ax.x_axis), FadeIn(bell_fill), run_time=1.2)
        self.add(ax)
        q1 = T("Balls drop through a Galton board...", 34, MUTED).to_edge(UP, buff=0.8)
        self.play(FadeIn(q1, shift=UP * 0.2))
        self.wait(3.0)
        q2 = T("...and demostrate the classic bell curve.", 34, MUTED).move_to(q1)
        self.play(FadeTransform(q1, q2))
        self.wait(2.5)

        # morph into a long tail
        def tail(x):
            u = (x + 3.6) / 7.2 * 9 + 1          # map [-3.6, 3.6] to [1, 10]
            return min(u ** (-ALPHA - 1) * 1.05, 1.08)
        pcurve = ax.plot(tail, x_range=[-3.6, 4], color=PARETO, stroke_width=6)
        pfill = ax.get_area(pcurve, x_range=[-3.6, 4], color=PARETO, opacity=0.25)
        q3 = T("But what if you wanted other distributions?", 34, PARETO).move_to(q1)
        mark(self, "N1b")
        self.play(FadeTransform(q2, q3), Transform(bell, pcurve), Transform(bell_fill, pfill), run_time=2.5)
        self.wait(1.0)
        words = VGroup(*[T(w, 28, GREY_B) for w in ["wealth", "city sizes", "followers", "earthquakes"]])
        words.arrange(RIGHT, buff=0.7).next_to(ax, DOWN, buff=0.35)
        self.play(LaggedStart(*[FadeIn(w, shift=UP * 0.15) for w in words], lag_ratio=0.5, run_time=3))
        self.wait(7.5)
        mark(self, "N1c")
        title = T("A Galton board for the Pareto curve", 54).move_to(UP * 0.4)
        sub = T("modeling the 80/20 rule with gravity", 30, MUTED).next_to(title, DOWN, buff=0.35)
        self.play(FadeOut(VGroup(ax, bell, bell_fill, words, q3)), run_time=1)
        self.play(Write(title, run_time=2), FadeIn(sub, shift=UP * 0.2, run_time=2))
        self.wait(3.5)
        self.play(FadeOut(VGroup(title, sub)))


# ============================================================================= scene 2
class S2Classic(Scene):
    def construct(self):
        n = 6
        B = Board(n, dx=0.78, dy=0.62, top=[0, 3.0, 0], peg_r=0.07, ball_r=0.09)
        pegs = B.pegs()
        floor = -3.55
        ytop_bins = B.exit_pt(0)[1] - 0.15
        walls = VGroup(*[Line([B.exit_pt(m)[0] - B.dx / 2, floor, 0], [B.exit_pt(m)[0] - B.dx / 2, ytop_bins, 0],
                              color=WALL, stroke_width=2.5) for m in range(n + 2)])
        base = Line([B.exit_pt(0)[0] - B.dx / 2, floor, 0], [B.exit_pt(n)[0] + B.dx / 2, floor, 0], color=WALL, stroke_width=2.5)
        board = VGroup(pegs, walls, base)

        mark(self, "N2a")
        self.play(LaggedStart(*[GrowFromCenter(p) for p in pegs], lag_ratio=0.03, run_time=2))
        self.play(Create(walls), Create(base), run_time=1)

        # one ball, slowly
        choices = [1, 0, 1, 1, 0, 1]
        hop = 1.1
        segs, t1, m = B.path(choices, 0, hop, start=B.top + UP * 1.0)
        tr = ValueTracker(0)
        ball = Dot(segs[0][2], radius=B.ball_r, color=BALL)
        ball.add_updater(lambda d: d.move_to(seg_pos(next((s for s in segs if s[0] <= tr.get_value() < s[1]), segs[-1]), tr.get_value())))
        trail = TracedPath(ball.get_center, stroke_color=BALL, stroke_width=3, stroke_opacity=0.6)
        self.add(trail, ball)
        letters = VGroup()
        seq_pos = np.array([4.6, 2.2, 0])
        self.play(tr.animate.set_value(hop * 0.9), run_time=hop * 0.9, rate_func=linear)
        for i, c in enumerate(choices):
            lab = T("R" if c else "L", 40, YELLOW if c else GREY_B)
            lab.move_to(seq_pos + RIGHT * 0.42 * i)
            pk = B.peg(i, sum(choices[:i]))
            flash = Circle(radius=0.16, color=YELLOW if c else GREY_B, stroke_width=3).move_to(pk)
            self.play(tr.animate.set_value(hop * 0.9 + (i + 1) * hop), FadeIn(lab, shift=DOWN * 0.15),
                      Flash(pk, color=YELLOW if c else GREY_B, line_length=0.12, flash_radius=0.2),
                      run_time=hop, rate_func=linear)
            letters.add(lab)
        fin = B.exit_pt(m)
        land = np.array([fin[0], floor + B.ball_r, 0])
        ball.clear_updaters()
        self.play(ball.animate.move_to(land), run_time=0.6, rate_func=rate_functions.ease_in_quad)
        self.wait(3.5)

        nums = VGroup(*[MathTex(str(k), font_size=36, color=GREY_B).move_to([B.exit_pt(k)[0], floor - 0.28, 0]) for k in range(n + 1)])
        mark(self, "N2b")
        self.play(FadeIn(nums, lag_ratio=0.1))
        four = MathTex(r"4 \text{ rights}", font_size=40, color=YELLOW).next_to(letters, DOWN, buff=0.35)
        arrow = Arrow(four.get_bottom(), nums[4].get_top() + UP * 0.1, buff=0.15, color=YELLOW, stroke_width=4)
        self.play(Write(four))
        self.play(GrowArrow(arrow), Indicate(nums[4], color=YELLOW))
        self.wait(3.5)
        self.play(FadeOut(VGroup(arrow, four, trail, ball)), letters.animate.set_opacity(0.4))

        # Pascal's triangle on the pegs
        pas = VGroup(*[MathTex(str(math.comb(i, j)), font_size=30, color=WHITE).move_to(B.peg(i, j))
                       for i in range(n) for j in range(i + 1)])
        fin_row = VGroup(*[MathTex(str(math.comb(n, k)), font_size=40, color=YELLOW).move_to([B.exit_pt(k)[0], B.exit_pt(k)[1] - 0.05, 0])
                           for k in range(n + 1)])
        caption = VGroup(T("number of paths", 28, MUTED), T("to each spot", 28, MUTED)).arrange(DOWN, buff=0.1).move_to([-4.4, 1.6, 0])
        self.play(FadeOut(letters), FadeIn(caption))
        self.play(LaggedStart(*[Transform(p, q) for p, q in zip(pegs, pas)], lag_ratio=0.05, run_time=3))
        self.play(LaggedStart(*[FadeIn(f, shift=DOWN * 0.2) for f in fin_row], lag_ratio=0.15, run_time=2))
        self.wait(11.0)
        # back to pegs
        pegs2 = B.pegs()
        self.play(*[Transform(p, q) for p, q in zip(pegs, pegs2)], FadeOut(caption), fin_row.animate.set_opacity(0), run_time=1.2)
        self.remove(fin_row)

        # rain of balls
        mark(self, "N2c")
        N = 420
        r = 0.055
        balls = []
        t = 0.0
        for k in range(N):
            ch = list(rng.integers(0, 2, n))
            gap = 0.5 if k < 6 else 0.03
            t += gap
            sg, te, mm = B.path(ch, t, 0.11, start=B.top + UP * 1.0)
            balls.append({"segs": sg, "t1": te + 0.25, "bin": mm, "end": B.exit_pt(mm)})
        balls.sort(key=lambda b: b["t1"])
        cnt = [0] * (n + 1)
        for b in balls:
            k = b["bin"]
            xl = B.exit_pt(k)[0] - B.dx / 2
            b["slot"] = stack_slot(cnt[k], xl, xl + B.dx, floor, r, gap=0.02)
            cnt[k] += 1
            b["segs"].append(seg(b["t1"] - 0.25, b["t1"], b["end"], b["slot"], 0, "fall"))
        self.remove(ball)
        rain = Rain(balls, r)
        dur = max(b["t1"] for b in balls) + 0.2
        held = rain.play(self, dur)
        # expected outline
        unit = 2 * r * 0.88 / ((B.dx - 0.04) // (2 * r))
        outline = VGroup()
        for k in range(n + 1):
            h = N * math.comb(n, k) / 2 ** n * unit
            xl = B.exit_pt(k)[0] - B.dx / 2
            outline.add(Rectangle(width=B.dx, height=h, stroke_color=YELLOW, stroke_width=3).move_to([xl + B.dx / 2, floor + h / 2, 0]))
        exp_lab = MathTex(r"\propto \binom{6}{k}", font_size=40, color=YELLOW).move_to([4.8, 0.2, 0])
        self.play(Create(outline), Write(exp_lab), run_time=1.5)
        self.wait(4.0)
        self.play(FadeOut(VGroup(held, outline, exp_lab, board, nums)))


# ============================================================================= scene 3
class S3Gauss(Scene):
    def construct(self):
        ax = Axes(x_range=[-5.5, 5.5, 1], y_range=[0, 0.5, 0.1], x_length=11, y_length=4.6,
                  axis_config={"color": GREY_C}, x_axis_config={"include_ticks": False},
                  y_axis_config={"include_ticks": False}).shift(DOWN * 0.9)
        ax.y_axis.set_opacity(0)

        def bars(n):
            sd = math.sqrt(n) / 2
            g = VGroup()
            for k in range(n + 1):
                z = (k - n / 2) / sd
                w = 1 / sd
                h = math.comb(n, k) / 2 ** n / w
                if abs(z) > 4.2:
                    continue
                p0 = ax.c2p(z - w / 2, 0)
                p1 = ax.c2p(z + w / 2, h)
                g.add(Rectangle(width=p1[0] - p0[0], height=max(p1[1] - p0[1], 0.001),
                                fill_color=GAUSS, fill_opacity=0.55, stroke_color=BLACK, stroke_width=1)
                      .move_to([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, 0]))
            return g

        mark(self, "N3a")
        label = T("6 rows", 34, MUTED).to_corner(UR, buff=0.6)
        b = bars(6)
        self.play(Create(ax), FadeIn(b, lag_ratio=0.1), FadeIn(label), run_time=1.8)
        self.wait(1.2)
        for n in [12, 24, 60]:
            nl = T(f"{n} rows", 34, MUTED).move_to(label, aligned_edge=RIGHT)
            self.play(Transform(b, bars(n)), Transform(label, nl), run_time=1.5)
            self.wait(0.6)
        curve = ax.plot(lambda x: math.exp(-x * x / 2) / math.sqrt(2 * PI), color=GAUSS, stroke_width=6)
        self.play(Create(curve), b.animate.set_fill(opacity=0.18), run_time=1.8)
        self.wait(1.0)

        mark(self, "N3b")
        f = MathTex(r"f(x)", r"=", r"\frac{1}{\sigma\sqrt{2\pi}}", r"\,e^{", r"-\frac{(x-\mu)^2}{2\sigma^2}", r"}",
                    font_size=54).to_edge(UP, buff=0.5).shift(LEFT * 1.2)
        name = T("the Gaussian (normal) distribution", 30, GAUSS).next_to(f, DOWN, buff=0.25)
        self.play(FadeOut(label), Write(f), FadeIn(name), run_time=2)
        self.wait(2.5)
        box = SurroundingRectangle(f[4], color=YELLOW, buff=0.08)
        sq = T("a square in the exponent", 28, YELLOW).next_to(f, RIGHT, buff=0.4)
        self.play(Create(box), FadeIn(sq, shift=LEFT * 0.2))
        self.wait(9.5)

        mark(self, "N3c")
        self.play(FadeOut(VGroup(box, sq, name)), f.animate.scale(0.7).to_corner(UL, buff=0.4), b.animate.set_fill(opacity=0))
        a1 = ax.get_area(curve, x_range=[-1, 1], color=GAUSS, opacity=0.55)
        a2 = ax.get_area(curve, x_range=[-2, 2], color=GAUSS, opacity=0.3)
        t1 = MathTex(r"68\%", font_size=44).move_to(ax.c2p(0, 0.16))
        br = BraceBetweenPoints(ax.c2p(-2, 0.42), ax.c2p(2, 0.42), UP, color=GREY_B)
        t2 = MathTex(r"95\%", font_size=40, color=GREY_A).next_to(br, UP, buff=0.1)
        ticks = VGroup(*[MathTex(s, font_size=30, color=GREY_B).next_to(ax.c2p(v, 0), DOWN, buff=0.15)
                         for v, s in [(-2, r"-2\sigma"), (-1, r"-\sigma"), (0, r"\mu"), (1, r"\sigma"), (2, r"2\sigma")]])
        self.play(FadeIn(ticks), FadeIn(a1), Write(t1))
        self.wait(1.5)
        self.play(FadeIn(a2), GrowFromCenter(br), Write(t2))
        self.wait(2.0)
        five = Arrow(ax.c2p(5, 0.16), ax.c2p(5, 0.01), buff=0, color=KNIFE, stroke_width=4)
        ft = VGroup(MathTex(r"\text{beyond } 5\sigma:", font_size=34), MathTex(r"< 1 \text{ in a million}", font_size=34, color=KNIFE)).arrange(DOWN, buff=0.12).next_to(five, UP, buff=0.1).shift(LEFT * 0.4)
        self.play(GrowArrow(five), FadeIn(ft, shift=DOWN * 0.2))
        self.wait(5.0)

        mark(self, "N3d")
        clt = VGroup(T("many small, independent pushes, added up", 32),
                     MathTex(r"\Downarrow", font_size=44),
                     T("bell curve", 34, GAUSS)).arrange(DOWN, buff=0.18).to_corner(UR, buff=0.5)
        self.play(FadeOut(VGroup(br, t2, five, ft)), FadeIn(clt[0], shift=DOWN * 0.2))
        self.play(FadeIn(clt[1:]))
        exs = T("heights  ·  measurement errors  ·  test scores", 26, MUTED).next_to(clt, DOWN, buff=0.3)
        self.play(FadeIn(exs))
        self.wait(9.0)
        tall = VGroup(T("Nobody is ten times", 34, YELLOW), T("taller than average.", 34, YELLOW)).arrange(DOWN, buff=0.12).move_to([-4.3, 0.7, 0])
        self.play(Write(tall), run_time=1.6)
        self.wait(2.5)
        self.play(FadeOut(Group(*self.mobjects)))


# ============================================================================= scene 4
class S4Pareto(Scene):
    def construct(self):
        mark(self, "N4a")
        vals = np.sort((1 - np.random.default_rng(3).random(48)) ** (-1 / ALPHA))[::-1]
        vals = np.minimum(vals, 40)
        H = 5.2
        bars = VGroup(*[Rectangle(width=0.2, height=max(v / vals[0] * H, 0.02), fill_color=PARETO, fill_opacity=0.85, stroke_width=0)
                        for v in vals]).arrange(RIGHT, buff=0.05, aligned_edge=DOWN).move_to(DOWN * 0.4)
        self.play(LaggedStart(*[GrowFromEdge(b, DOWN) for b in bars], lag_ratio=0.05, run_time=3))
        cap = T("a few giants, and a huge crowd of small values", 32, MUTED).to_edge(UP, buff=0.6)
        self.play(FadeIn(cap))
        self.wait(8.5)

        mark(self, "N4b")
        name = T("the Pareto distribution", 36, PARETO).to_edge(UP, buff=0.6)
        law = MathTex(r"P(X \ge x)", r"=", r"x^{-\alpha}", font_size=64).next_to(name, DOWN, buff=0.35)
        cond = MathTex(r"(x \ge 1)", font_size=36, color=GREY_B).next_to(law, RIGHT, buff=0.4)
        self.play(FadeOut(bars), FadeTransform(cap, name))
        self.play(Write(law), FadeIn(cond))
        self.wait(11.0)

        mark(self, "N4c")
        grp = VGroup(name, law, cond)
        self.play(grp.animate.scale(0.7).to_corner(UL, buff=0.4))
        ax = Axes(x_range=[0, 10, 1], y_range=[0, 1, 0.25], x_length=8.2, y_length=4.2,
                  axis_config={"color": GREY_C, "include_tip": False},
                  x_axis_config={"numbers_to_include": [1, 2, 4, 8], "font_size": 30},
                  y_axis_config={"numbers_to_include": [0.5, 1.0], "font_size": 28, "decimal_number_config": {"num_decimal_places": 1}}).to_edge(LEFT, buff=0.9).shift(DOWN * 1.1)
        xl = MathTex("x", font_size=36).next_to(ax.x_axis, RIGHT, buff=0.15)
        yl = MathTex(r"P(X\ge x)", font_size=32).next_to(ax.y_axis, UP, buff=0.15)
        curve = ax.plot(lambda x: x ** (-ALPHA), x_range=[1, 10], color=PARETO, stroke_width=6)
        self.play(Create(ax), FadeIn(xl), FadeIn(yl))
        self.play(Create(curve), run_time=2)
        dots = VGroup()
        lines = VGroup()
        for x in [1, 2, 4, 8]:
            p = ax.c2p(x, x ** (-ALPHA))
            dots.add(Dot(p, color=WHITE, radius=0.07))
            lines.add(DashedLine(ax.c2p(x, 0), p, color=GREY_B, stroke_width=2))
        self.play(LaggedStart(*[AnimationGroup(Create(l), FadeIn(d)) for l, d in zip(lines, dots)], lag_ratio=0.4, run_time=2.5))
        arcs = VGroup()
        for a, b2 in zip(dots[:-1], dots[1:]):
            arc = CurvedArrow(a.get_center() + UP * 0.25, b2.get_center() + UP * 0.25, angle=-PI / 3, color=YELLOW, stroke_width=3)
            lab = MathTex(r"\times 0.45", font_size=30, color=YELLOW).next_to(arc, UP, buff=0.05)
            arcs.add(VGroup(arc, lab))
        self.play(LaggedStart(*[FadeIn(a) for a in arcs], lag_ratio=0.5, run_time=3))
        rule = VGroup(MathTex(r"\text{double } x", font_size=40), MathTex(r"\Downarrow", font_size=40),
                      MathTex(r"\text{share shrinks} \times 2^{-\alpha}", font_size=40)).arrange(DOWN, buff=0.15).to_edge(RIGHT, buff=0.6).shift(UP * 1.2)
        self.play(Write(rule))
        self.wait(4.0)
        same = VGroup(T("1 → 2 costs the same", 28, YELLOW), T("as 1,000 → 2,000", 28, YELLOW)).arrange(DOWN, buff=0.1).next_to(rule, DOWN, buff=0.45)
        self.play(FadeIn(same, shift=DOWN * 0.15))
        self.wait(3.5)
        scale = VGroup(T("no typical size:", 28, MUTED), T("the same at every scale", 28, MUTED)).arrange(DOWN, buff=0.1).next_to(same, DOWN, buff=0.45)
        self.play(FadeIn(scale))
        self.wait(3.0)

        mark(self, "N4d")
        self.play(FadeOut(VGroup(ax, xl, yl, curve, dots, lines, arcs, rule, same, scale)))
        a116 = MathTex(r"\alpha \approx 1.16", font_size=48, color=PARETO).move_to(UP * 2)
        pop = VGroup(Rectangle(width=8, height=0.7, stroke_color=WHITE),
                     Rectangle(width=1.6, height=0.7, fill_color=PARETO, fill_opacity=0.9, stroke_width=0))
        pop[1].align_to(pop[0], LEFT)
        wea = VGroup(Rectangle(width=8, height=0.7, stroke_color=WHITE),
                     Rectangle(width=6.4, height=0.7, fill_color=PARETO, fill_opacity=0.9, stroke_width=0))
        wea[1].align_to(wea[0], LEFT)
        rows = VGroup(pop, wea).arrange(DOWN, buff=0.9).shift(RIGHT * 0.8 + DOWN * 0.4)
        l1 = T("people", 30, MUTED).next_to(pop, LEFT, buff=0.3)
        l2 = T("total", 30, MUTED).next_to(wea, LEFT, buff=0.3)
        p20 = MathTex(r"20\%", font_size=36, color=BLACK).move_to(pop[1])
        p80 = MathTex(r"80\%", font_size=36, color=BLACK).move_to(wea[1])
        self.play(Write(a116))
        self.play(Create(pop[0]), Create(wea[0]), FadeIn(l1), FadeIn(l2))
        self.play(GrowFromEdge(pop[1], LEFT), FadeIn(p20))
        self.play(GrowFromEdge(wea[1], LEFT), FadeIn(p80), run_time=1.5)
        rule8020 = T("the 80/20 rule", 40, PARETO).next_to(rows, DOWN, buff=0.6)
        self.play(Write(rule8020))
        self.wait(4.0)

        mark(self, "N4e")
        self.play(FadeOut(VGroup(a116, pop, wea, l1, l2, p20, p80, rule8020)), FadeOut(grp))
        lax = Axes(x_range=[0, 3, 1], y_range=[0, 6, 1], x_length=8, y_length=4.6,
                   axis_config={"color": GREY_C, "include_tip": False, "font_size": 28},
                   x_axis_config={"numbers_to_include": []}, y_axis_config={"numbers_to_include": []}).shift(DOWN * 0.55 + RIGHT * 1.2)
        xt = VGroup(*[MathTex(s, font_size=30, color=GREY_B).next_to(lax.c2p(v, 0), DOWN, buff=0.15) for v, s in [(0, "1"), (1, "10"), (2, "100"), (3, "1000")]])
        yt = VGroup(*[MathTex(s, font_size=28, color=GREY_B).next_to(lax.c2p(0, v + 6), LEFT, buff=0.15) for v, s in [(0, "1"), (-2, "10^{-2}"), (-4, "10^{-4}"), (-6, "10^{-6}")]])
        xl2 = MathTex(r"x \text{ (log scale)}", font_size=32).next_to(lax.x_axis, DOWN, buff=0.6)
        yl2 = MathTex(r"P(X \ge x) \text{ (log scale)}", font_size=32).next_to(lax, UP, buff=0.2).align_to(lax, LEFT).shift(LEFT * 0.6)
        self.play(Create(lax), FadeIn(xt), FadeIn(yt), FadeIn(xl2), FadeIn(yl2))
        pl = lax.plot(lambda u: 6 - ALPHA * u, x_range=[0, 3], color=PARETO, stroke_width=6)
        gl = lax.plot(lambda u: max(6 - (10 ** (2 * u) - 1) / 2 / math.log(10), 0), x_range=[0, 0.6, 0.005], color=GAUSS, stroke_width=6)
        pt = T("Pareto: a straight line", 30, PARETO).move_to(lax.c2p(1.75, 5.3))
        slope = MathTex(r"\text{slope} = -\alpha", font_size=34, color=PARETO).next_to(pt, DOWN, buff=0.15)
        gt = T("Gaussian: falls off a cliff", 30, GAUSS).move_to(lax.c2p(1.3, 1.1))
        self.play(Create(pl), run_time=2)
        self.play(FadeIn(pt), Write(slope))
        self.wait(1.5)
        self.play(Create(gl), run_time=2)
        self.play(FadeIn(gt))
        self.wait(5.5)
        self.play(FadeOut(Group(*self.mobjects)))


# ============================================================================= scene 5
SX, SY = 1.62, 1.05
NR = 5
DXS, DYS = 0.22, 0.10
O0 = np.array([-6.0, 3.3, 0])
FLOOR5 = -3.78


def O(k):
    return O0 + np.array([k * SX, -k * SY, 0])


def stage_board(k):
    return Board(NR, DXS, DYS, O(k), peg_r=0.028, ball_r=0.035)


def knife_pt(k):
    return O(k) + np.array([0, -NR * DYS - 0.03, 0])


def ramp_end(k):            # where the ramp of stage k meets the top of stage k+1's funnel (left wall)
    return O(k + 1) + np.array([-0.60, 0.36, 0])


def throat(k):
    return O(k) + np.array([0, 0.15, 0])


def ramp_y(k, x):
    a, b = knife_pt(k), ramp_end(k)
    return a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0])


def bin_lr(k):
    left = O(k)[0] - 0.80
    return left, left + SX


class S5Board(Scene):
    def build_stage_art(self, k, show_funnel=True):
        B = stage_board(k)
        g = VGroup()
        g.add(B.pegs())
        o = O(k)
        if show_funnel:
            g.add(Line(o + [-0.62, 0.34, 0], o + [-0.07, 0.13, 0], color=WALL, stroke_width=2.5))
            g.add(Line(o + [0.62, 0.34, 0], o + [0.07, 0.13, 0], color=WALL, stroke_width=2.5))
        kp = knife_pt(k)
        g.add(Triangle(color=KNIFE, fill_color=KNIFE, fill_opacity=1).scale(0.06).move_to(kp + DOWN * 0.03))
        g.add(Line(kp, ramp_end(k), color=WALL, stroke_width=2.5))
        return g

    def construct(self):
        # --- adding vs surviving
        mark(self, "N5a")
        add = VGroup(T("adding", 44, GAUSS), MathTex(r"\Rightarrow", font_size=50), T("bell curve", 44, GAUSS)).arrange(RIGHT, buff=0.35).shift(UP * 0.8)
        surv = VGroup(T("surviving", 44, PARETO), MathTex(r"\Rightarrow", font_size=50), T("power law ?", 44, PARETO)).arrange(RIGHT, buff=0.35).shift(DOWN * 0.6)
        self.play(FadeIn(add, shift=UP * 0.2))
        self.wait(4.5)
        self.play(FadeIn(surv, shift=UP * 0.2))
        self.wait(7.5)
        self.play(FadeOut(VGroup(add, surv)))

        # --- one big stage with a knife at the median
        mark(self, "N5b")
        n = 7
        B = Board(n, dx=0.5, dy=0.42, top=[-1.5, 2.55, 0], peg_r=0.055, ball_r=0.07)
        pegs = B.pegs()
        floor = -3.4
        xL, xR = B.exit_pt(0)[0] - B.dx / 2, B.exit_pt(n)[0] + B.dx / 2
        knife_x = B.top[0]
        ky = B.exit_pt(0)[1] - 0.12
        fun = VGroup(Line(B.top + [-1.1, 0.75, 0], B.top + [-0.16, 0.33, 0], color=WALL, stroke_width=3),
                     Line(B.top + [1.1, 0.75, 0], B.top + [0.16, 0.33, 0], color=WALL, stroke_width=3))
        self.play(LaggedStart(*[GrowFromCenter(p) for p in pegs], lag_ratio=0.02, run_time=1.5), Create(fun))
        # ghost bell: where the balls would land
        bell = VGroup()
        for m in range(n + 1):
            h = math.comb(n, m) / 2 ** n * 9
            x = B.exit_pt(m)[0]
            bell.add(Rectangle(width=B.dx * 0.92, height=h, fill_color=GAUSS, fill_opacity=0.35, stroke_width=0)
                     .move_to([x, floor + h / 2, 0]))
        bl = T("where balls land: a bell curve", 28, GAUSS).move_to([3.6, -0.6, 0])
        self.play(LaggedStart(*[GrowFromEdge(b, DOWN) for b in bell], lag_ratio=0.08), FadeIn(bl))
        self.wait(5.5)
        knife = Triangle(color=KNIFE, fill_color=KNIFE, fill_opacity=1).scale(0.14).move_to([knife_x, ky - 0.1, 0])
        kline = DashedLine([knife_x, ky, 0], [knife_x, floor, 0], color=KNIFE, stroke_width=3)
        kl = T("knife edge at the median", 28, KNIFE).next_to(knife, UP, buff=0.15).shift(RIGHT * 2.6 + DOWN * 0.15)
        self.play(FadeIn(knife, shift=UP * 0.2), Create(kline), FadeIn(kl))
        left = VGroup(*bell[:4]); right = VGroup(*bell[4:])
        self.play(left.animate.set_fill(PARETO, opacity=0.6), right.animate.set_fill(GAUSS, opacity=0.6))
        self.wait(2.0)
        ramp = Line([knife_x, ky - 0.05, 0], [xR + 1.6, ky - 1.0, 0], color=WALL, stroke_width=4)
        h1 = MathTex(r"\tfrac12 \text{ stop}", font_size=40, color=PARETO).next_to(left, LEFT, buff=0.4)
        h2 = MathTex(r"\tfrac12 \text{ roll on}", font_size=40, color=GAUSS).next_to(ramp.get_end(), DOWN, buff=0.25)
        self.play(Create(ramp), FadeIn(h1), FadeIn(h2), FadeOut(bl))
        nxt = T("...into another identical stage", 28, MUTED).next_to(h2, DOWN, buff=0.2)
        self.play(FadeIn(nxt))
        self.wait(8.5)
        mark(self, "N5d")
        hide = T("The bell curve is still here, used as a perfectly fair coin.", 30, YELLOW).to_edge(UP, buff=0.12)
        self.play(FadeIn(hide, shift=DOWN * 0.15))
        self.wait(7.5)
        self.play(FadeOut(VGroup(pegs, fun, bell, knife, kline, kl, ramp, h1, h2, nxt, hide)))

        # --- the staircase
        mark(self, "N5c")
        art = VGroup(*[self.build_stage_art(k) for k in range(6)])
        divs = VGroup()
        for k in range(7):
            x = bin_lr(k)[0]
            ytop = ramp_y(k - 1, x) - 0.06 if k >= 1 else O(0)[1] + 0.34
            divs.add(Line([x, FLOOR5, 0], [x, ytop, 0], color=WALL, stroke_width=2))
        xr = bin_lr(6)[1]
        divs.add(Line([xr, FLOOR5, 0], [xr, ramp_end(5)[1] + 0.3, 0], color=WALL, stroke_width=2))
        floorl = Line([bin_lr(0)[0], FLOOR5, 0], [xr, FLOOR5, 0], color=WALL, stroke_width=2)
        self.play(LaggedStart(*[FadeIn(a, shift=DOWN * 0.1) for a in art], lag_ratio=0.25, run_time=3), Create(divs), Create(floorl))

        # simulate 1,000 balls
        N = 1000
        r = 0.034
        hop = 0.085
        balls = []
        t = 0.0
        srng = np.random.default_rng(5)
        for i in range(N):
            gap = 0.9 if i < 5 else 0.022
            t += gap
            segs = []
            tt = t
            start = O(0) + np.array([0, 1.0, 0])
            slow = 1 if i >= 5 else 2.4
            h = hop if i >= 5 else 0.22
            k = 0
            while True:
                Bk = stage_board(k)
                sg, tt, m = Bk.path(list(srng.integers(0, 2, NR)), tt, h, start=start)
                segs += sg
                ex = Bk.exit_pt(m)
                if m <= 2:                       # left of the knife: stop in this stage's bin
                    bink = k
                    break
                pr = np.array([ex[0], ramp_y(k, ex[0]) + r, 0])
                segs.append(seg(tt, tt + 0.06 * slow, ex, pr, 0, "fall")); tt += 0.06 * slow
                pe = ramp_end(k) + np.array([0, r, 0])
                segs.append(seg(tt, tt + 0.32 * slow, pr, pe, 0, "smooth")); tt += 0.32 * slow
                if k == 5:                       # last ramp feeds the tail bin
                    bink, ex = 6, pe
                    break
                th = throat(k + 1) + np.array([0, r, 0])
                segs.append(seg(tt, tt + 0.16 * slow, pe, th, 0, "smooth")); tt += 0.16 * slow
                segs.append(seg(tt, tt + 0.07 * slow, th, stage_board(k + 1).on(0, 0), 0, "fall")); tt += 0.07 * slow
                k += 1
                start = None
            balls.append({"segs": segs, "t1": tt + 0.3, "bin": bink, "end": ex})
        balls.sort(key=lambda b: b["t1"])
        cnt = [0] * 7
        for b in balls:
            k = b["bin"]
            l, rr = bin_lr(k)
            b["slot"] = stack_slot(cnt[k], l, rr, FLOOR5, r, gap=0.03)
            cnt[k] += 1
            b["segs"].append(seg(b["t1"] - 0.3, b["t1"], b["end"], b["slot"], 0, "fall"))
        self.counts = cnt
        rain = Rain(balls, r)
        dur = max(b["t1"] for b in balls) + 0.3
        held = rain.play(self, dur)

        mark(self, "N5c2")
        cl = VGroup()
        for k in range(7):
            l, rr = bin_lr(k)
            top = FLOOR5 + (cnt[k] // max(int((rr - l - 0.06) // (2 * r)), 1) + 1) * 2 * r * 0.88
            cl.add(MathTex(f"{cnt[k]}", font_size=30, color=WHITE).move_to([(l + rr) / 2, top + 0.22, 0]))
        self.play(LaggedStart(*[FadeIn(c, shift=UP * 0.1) for c in cl], lag_ratio=0.3, run_time=2.5))
        fr = VGroup(*[MathTex(s, font_size=30, color=YELLOW) for s in [r"\tfrac12", r"\tfrac14", r"\tfrac18", r"\tfrac1{16}", r"\tfrac1{32}", r"\tfrac1{64}", r"\tfrac1{64}"]])
        for f, c in zip(fr, cl):
            f.next_to(c, UP, buff=0.12)
        self.play(LaggedStart(*[FadeIn(f) for f in fr], lag_ratio=0.3, run_time=2.5))
        self.wait(8.5)

        mark(self, "N5e")
        labs = [r"1", r"1.82", r"3.30", r"6.01", r"10.9", r"19.8", r"\ge 36"]
        vl = VGroup(*[MathTex(t_, font_size=32, color=PARETO).move_to(f) for t_, f in zip(labs, fr)])
        vtitle = T("bin values", 30, PARETO)
        times = MathTex(r"\times 1.82 \text{ each step}", font_size=34, color=PARETO)
        fixed = VGroup(T("fixed before", 26, MUTED), T("any ball drops", 26, MUTED)).arrange(DOWN, buff=0.08)
        VGroup(vtitle, times, fixed).arrange(DOWN, buff=0.2).to_corner(UR, buff=0.45)
        self.play(FadeIn(vtitle))
        self.wait(3.0)
        self.play(LaggedStart(*[FadeTransform(f, v) for f, v in zip(fr, vl)], lag_ratio=0.25, run_time=3))
        self.play(Write(times))
        self.wait(9.0)
        self.play(FadeIn(fixed))
        self.wait(6.5)

        # --- derivation
        mark(self, "N5f")
        stair = VGroup(art, divs, floorl, held, cl, vl, vtitle, times, fixed)
        self.play(FadeOut(stair), run_time=1)
        d1 = MathTex(r"P(\text{reach bin } k)", r"=", r"\left(\tfrac12\right)^k", font_size=48)
        d2 = MathTex(r"x", r"=", r"b^k", r"\quad\Rightarrow\quad k = \frac{\ln x}{\ln b}", font_size=48)
        d3 = MathTex(r"P(X \ge x)", r"=", r"\left(\tfrac12\right)^{\ln x/\ln b}", r"=", r"x^{-\ln 2/\ln b}", font_size=48)
        d4 = MathTex(r"\alpha", r"=", r"\frac{\ln 2}{\ln b}", r"=", r"\frac{\ln 2}{\ln 1.82}", r"\approx", r"1.16", font_size=52)
        D = VGroup(d1, d2, d3, d4).arrange(DOWN, buff=0.55, aligned_edge=LEFT).move_to(ORIGIN)
        d1[2].set_color(YELLOW); d2[2].set_color(PARETO); d4[6].set_color(PARETO)
        self.play(Write(d1), run_time=1.5)
        self.wait(6.0)
        self.play(Write(d2), run_time=1.5)
        self.wait(6.0)
        self.play(Write(d3), run_time=2)
        self.wait(3.0)
        box = SurroundingRectangle(d3[4], color=PARETO, buff=0.12)
        self.play(Create(box))
        self.wait(3.0)
        self.play(Write(d4), run_time=2)
        self.play(Indicate(d4[6], color=PARETO))
        self.wait(7.0)

        # --- log-log check
        mark(self, "N5g")
        self.play(FadeOut(VGroup(D, box)))
        lax = Axes(x_range=[0, 1.8, 0.5], y_range=[0, 2.2, 0.5], x_length=8.5, y_length=4.8,
                   axis_config={"color": GREY_C, "include_tip": False},
                   x_axis_config={"numbers_to_include": []}, y_axis_config={"numbers_to_include": []}).shift(DOWN * 0.3 + RIGHT * 0.3)
        xt = VGroup(*[MathTex(s, font_size=28, color=GREY_B).next_to(lax.c2p(v, 0), DOWN, buff=0.15) for v, s in [(0, "1"), (1, "10"), (math.log10(30), "30")]])
        yt = VGroup(*[MathTex(s, font_size=28, color=GREY_B).next_to(lax.c2p(0, v + 2.2), LEFT, buff=0.15) for v, s in [(0, "1"), (-1, "0.1"), (-2, "0.01")]])
        xl = MathTex(r"\text{bin value } x", font_size=32).next_to(lax.x_axis, DOWN, buff=0.65)
        yl = MathTex(r"\text{share of balls with value} \ge x", font_size=32).next_to(lax, UP, buff=0.15).align_to(lax, LEFT)
        self.play(Create(lax), FadeIn(xt), FadeIn(yt), FadeIn(xl), FadeIn(yl))
        tot = sum(cnt)
        pts = VGroup()
        for k in range(7):
            surv = sum(cnt[k:]) / tot
            pts.add(Dot(lax.c2p(k * math.log10(BASE), math.log10(surv) + 2.2), radius=0.09, color=PARETO))
        line = lax.plot(lambda u: 2.2 - ALPHA * u, x_range=[0, 1.8], color=WHITE, stroke_width=3)
        line.set_stroke(opacity=0.7)
        self.play(LaggedStart(*[GrowFromCenter(p) for p in pts], lag_ratio=0.3, run_time=2.5))
        self.play(Create(line), run_time=1.5)
        sl = MathTex(r"\text{slope} = -1.16", font_size=40, color=WHITE).move_to(lax.c2p(1.25, 1.7))
        self.play(Write(sl))
        self.wait(4.5)
        self.play(FadeOut(Group(*self.mobjects)))


# ============================================================================= scene 6
class S6Close(Scene):
    def construct(self):
        mark(self, "N6")
        # left: classic board + bell
        B = Board(5, dx=0.42, dy=0.34, top=[-3.6, 2.3, 0], peg_r=0.045, ball_r=0.05)
        lb = B.pegs()
        lax = Axes(x_range=[-3, 3], y_range=[0, 1.1], x_length=4.2, y_length=1.8, axis_config={"color": GREY_C, "include_ticks": False, "include_tip": False}).move_to([-3.6, -0.9, 0])
        lax.y_axis.set_opacity(0)
        bell = lax.plot(lambda x: math.exp(-x * x / 2), color=GAUSS, stroke_width=5)
        ltxt = VGroup(T("small effects add up", 30), T("bell curve", 36, GAUSS)).arrange(DOWN, buff=0.15).move_to([-3.6, -2.75, 0])
        # right: staircase sketch + straight line on log-log
        mini = VGroup()
        for k in range(4):
            o = np.array([1.9 + k * 0.75, 2.2 - k * 0.48, 0])
            mini.add(VGroup(*[Dot(o + np.array([(j - i / 2) * 0.11, -i * 0.07, 0]), radius=0.02, color=PEG) for i in range(4) for j in range(i + 1)]))
            mini.add(Triangle(color=KNIFE, fill_color=KNIFE, fill_opacity=1).scale(0.035).move_to(o + [0, -0.33, 0]))
            mini.add(Line(o + [0, -0.31, 0], o + [0.75, -0.48 + 0.16, 0], color=WALL, stroke_width=2))
        rax = Axes(x_range=[0, 2], y_range=[0, 2.3], x_length=4.2, y_length=1.8, axis_config={"color": GREY_C, "include_ticks": False, "include_tip": False}).move_to([3.6, -0.9, 0])
        rl = rax.plot(lambda u: 2.3 - ALPHA * u, x_range=[0, 1.95], color=PARETO, stroke_width=5)
        rtxt = VGroup(T("things survive round after round", 30), T("power law", 36, PARETO)).arrange(DOWN, buff=0.15).move_to([3.6, -2.75, 0])
        div = DashedLine(UP * 3.4, DOWN * 3.4, color=GREY_D)
        self.play(FadeIn(lb), Create(lax), Create(bell), run_time=1.5)
        self.play(FadeIn(ltxt, shift=UP * 0.15))
        self.wait(5.0)
        self.play(Create(div), FadeIn(mini), Create(rax), Create(rl), run_time=1.5)
        self.play(FadeIn(rtxt, shift=UP * 0.15))
        self.wait(8.0)
        mark(self, "N6b")
        both = VGroup(T("One board, both shapes:", 30, YELLOW), T("a bell curve inside every stage, a Pareto curve across them", 28, YELLOW)).arrange(DOWN, buff=0.12).to_edge(UP, buff=0.15)
        self.play(Write(both), run_time=2.5)
        self.wait(5.0)
        self.play(FadeOut(Group(*self.mobjects)))
        end = VGroup(T("A Galton board for the Pareto curve", 44), T("modeling the 80/20 rule with gravity", 28, MUTED)).arrange(DOWN, buff=0.3)
        self.play(FadeIn(end, shift=UP * 0.2))
        self.wait(3.5)
        self.play(FadeOut(end))
