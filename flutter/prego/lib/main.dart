import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart'
    show LicenseEntryWithLineBreaks, LicenseRegistry;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  LicenseRegistry.addLicense(() async* {
    for (final font in [
      'AtkinsonHyperlegible',
      'AtkinsonHyperlegibleMono',
      'Shrikhand',
    ]) {
      yield LicenseEntryWithLineBreaks([
        font,
      ], await rootBundle.loadString('assets/fonts/$font-OFL.txt'));
    }
  });
  final preferences = await SharedPreferences.getInstance();
  runApp(MyApp(preferences: preferences));
}

class MyApp extends StatefulWidget {
  const MyApp({super.key, required this.preferences});

  final SharedPreferences preferences;

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  late bool _darkMode;

  @override
  void initState() {
    super.initState();
    _darkMode = widget.preferences.getBool('darkMode') ?? false;
  }

  void _changeTheme() {
    setState(() => _darkMode = !_darkMode);
    unawaited(widget.preferences.setBool('darkMode', _darkMode));
  }

  @override
  Widget build(BuildContext context) {
    final colors = _Palette(dark: _darkMode);
    return MaterialApp(
      title: 'Prego',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: _darkMode ? Brightness.dark : Brightness.light,
        scaffoldBackgroundColor: colors.strip,
        fontFamily: 'Atkinson Hyperlegible',
        colorScheme: ColorScheme.fromSeed(
          seedColor: colors.dye,
          brightness: _darkMode ? Brightness.dark : Brightness.light,
          surface: colors.plastic,
          primary: colors.dye,
          onPrimary: colors.onDye,
          onSurface: colors.pine,
        ),
      ),
      home: MyHomePage(onChangeTheme: _changeTheme),
    );
  }
}

class _Palette {
  const _Palette({required this.dark});

  factory _Palette.of(BuildContext context) =>
      _Palette(dark: Theme.of(context).brightness == Brightness.dark);

  final bool dark;

  // Prego design system tokens.
  Color get strip => Color(dark ? 0xFF0B2320 : 0xFFDCF5E7);
  Color get plastic => Color(dark ? 0xFF14352F : 0xFFFBFFFD);
  Color get window => Color(dark ? 0xFF1D463E : 0xFFC4EBD6);
  Color get pine => Color(dark ? 0xFFE8FBF2 : 0xFF0F2A25);
  Color get pineSoft => Color(dark ? 0xFFA6C8BC : 0xFF38544C);
  Color get dye => Color(dark ? 0xFFFF74B4 : 0xFFB50E62);
  Color get onDye => Color(dark ? 0xFF2B0518 : 0xFFFFFFFF);
  Color get dyeDeep => Color(dark ? 0xFFA82A6C : 0xFF7D0A44);
  Color get wash => Color(dark ? 0xFF4A1231 : 0xFFFFD6E7);
  Color get stickShadow => Color(dark ? 0xFF04110F : 0xFF9CCDB4);

  // The stick is a physical object, so it keeps its colors in both themes.
  static const stickBody = Color(0xFFFBFFFD);
  static const stickCap = Color(0xFF7FE0B8);
  static const stickRib = Color(0xFF3FBF92);
  static const stickWindow = Color(0xFFDCF5E7);
  static const stickLine = Color(0xFFB50E62);
}

enum _Phase { ready, collecting, thinking, result }

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.onChangeTheme, this.random});

  final VoidCallback onChangeTheme;
  final Random? random;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  final _stopwatch = Stopwatch();
  late final _random = widget.random ?? Random();
  Timer? _ticker;
  Timer? _revealTimer;
  _Phase _phase = _Phase.ready;
  bool _isPregnant = false;
  int _numberOfChildren = 0;

  @override
  void dispose() {
    _ticker?.cancel();
    _revealTimer?.cancel();
    _stopwatch.stop();
    super.dispose();
  }

  void _start() {
    if (_phase != _Phase.ready) return;
    _stopwatch
      ..reset()
      ..start();
    setState(() => _phase = _Phase.collecting);
    _ticker = Timer.periodic(const Duration(milliseconds: 50), (_) {
      setState(() {});
    });
  }

  void _reveal() {
    if (_phase != _Phase.collecting) return;
    _ticker?.cancel();
    _stopwatch.stop();
    setState(() => _phase = _Phase.thinking);
    // The original novelty logic: no sensors or medical inference.
    _isPregnant = _random.nextInt(100) < 25;
    _numberOfChildren = _isPregnant ? _random.nextInt(10) + 1 : 0;
    _revealTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _phase = _Phase.result);
    });
  }

  void _reset() {
    if (_phase != _Phase.result) return;
    _stopwatch.reset();
    setState(() => _phase = _Phase.ready);
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int value) => value.toString().padLeft(2, '0');
    final minutes = twoDigits(duration.inMinutes);
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    final centiseconds = twoDigits(
      duration.inMilliseconds.remainder(1000) ~/ 10,
    );
    return '$minutes:$seconds.$centiseconds';
  }

  @override
  Widget build(BuildContext context) {
    final colors = _Palette.of(context);
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value:
          (colors.dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark)
              .copyWith(
                statusBarColor: Colors.transparent,
                systemNavigationBarColor: colors.strip,
              ),
      child: Scaffold(
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) => SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Center(
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: 460,
                    minHeight: constraints.maxHeight,
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _header(colors),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 32),
                        child: _experiment(colors),
                      ),
                      const SizedBox(height: 72),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _header(_Palette colors) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      children: [
        Expanded(
          child: Align(
            alignment: Alignment.centerLeft,
            child: Semantics(
              label: 'Prego, open-source licenses',
              excludeSemantics: true,
              button: true,
              child: Tooltip(
                message: 'Open-source licenses',
                child: TextButton(
                  onPressed: () => showLicensePage(
                    context: context,
                    applicationName: 'Prego',
                  ),
                  style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    alignment: Alignment.centerLeft,
                  ),
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text.rich(
                      TextSpan(
                        text: 'prego',
                        children: [
                          TextSpan(
                            text: '.',
                            style: TextStyle(color: colors.dye),
                          ),
                        ],
                      ),
                      textScaler: TextScaler.noScaling,
                      style: _display(colors, 34),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        IconButton(
          onPressed: widget.onChangeTheme,
          tooltip: colors.dark ? 'Switch to light mode' : 'Switch to dark mode',
          icon: Icon(
            colors.dark ? Icons.light_mode_rounded : Icons.dark_mode_rounded,
            size: 24,
            color: colors.pine,
          ),
        ),
      ],
    ),
  );

  Widget _experiment(_Palette colors) {
    final result = _phase == _Phase.result;
    final active = _phase == _Phase.collecting || _phase == _Phase.thinking;
    final status = switch (_phase) {
      _Phase.ready => 'Ready when you are.',
      _Phase.collecting => 'Take your time.',
      _Phase.thinking => 'Very scientific.',
      _Phase.result =>
        '$_numberOfChildren ${_numberOfChildren == 1 ? 'baby' : 'babies'}',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _TestIllustration(
          active: active,
          lines: switch (_phase) {
            _Phase.ready || _Phase.collecting => 0,
            _Phase.thinking => 1,
            _Phase.result => _isPregnant ? 2 : 1,
          },
        ),
        const SizedBox(height: 32),
        if (result)
          _ResultSheet(pregnant: _isPregnant, count: status)
        else ...[
          Semantics(
            label: 'Elapsed time',
            value: _formatDuration(_stopwatch.elapsed),
            excludeSemantics: true,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                _formatDuration(_stopwatch.elapsed),
                key: const ValueKey('elapsed-time'),
                style: TextStyle(
                  color: colors.pine,
                  fontFamily: 'Atkinson Hyperlegible Mono',
                  fontSize: 56,
                  fontVariations: const [FontVariation('wght', 500)],
                  letterSpacing: -1.12,
                  height: 60 / 56,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Semantics(
            liveRegion: true,
            child: Text(
              status,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: colors.pineSoft,
                fontSize: 16,
                height: 1.5,
              ),
            ),
          ),
        ],
        const SizedBox(height: 32),
        Align(
          child: _ActionButton(
            key: const ValueKey('primary-action'),
            onPressed: switch (_phase) {
              _Phase.ready => _start,
              _Phase.collecting => _reveal,
              _Phase.thinking => null,
              _Phase.result => _reset,
            },
            label: switch (_phase) {
              _Phase.ready => 'Start',
              _Phase.collecting => 'Reveal',
              _Phase.thinking => 'Thinking…',
              _Phase.result => 'Try again',
            },
          ),
        ),
      ],
    );
  }
}

TextStyle _display(_Palette colors, double size, {Color? color}) => TextStyle(
  fontFamily: 'Shrikhand',
  fontSize: size,
  fontWeight: FontWeight.w400,
  height: 1.14,
  color: color ?? colors.pine,
);

class _ResultSheet extends StatelessWidget {
  const _ResultSheet({required this.pregnant, required this.count});

  final bool pregnant;
  final String count;

  @override
  Widget build(BuildContext context) {
    final colors = _Palette.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: pregnant ? colors.wash : colors.plastic,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            Semantics(
              liveRegion: true,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  pregnant ? 'Pregnant.' : 'Not pregnant.',
                  textAlign: TextAlign.center,
                  style: _display(
                    colors,
                    44,
                    color: pregnant ? colors.dye : colors.pine,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Semantics(
              liveRegion: true,
              child: Text(
                count,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: colors.pine,
                  fontFamily: 'Atkinson Hyperlegible Mono',
                  fontSize: 20,
                  fontVariations: const [FontVariation('wght', 500)],
                  height: 1.3,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Results are random. Not medical advice.',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: colors.pineSoft,
                fontSize: 13,
                height: 18 / 13,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionButton extends StatefulWidget {
  const _ActionButton({super.key, required this.label, this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  State<_ActionButton> createState() => _ActionButtonState();
}

class _ActionButtonState extends State<_ActionButton> {
  static const _offset = 4.0;

  bool _pressed = false;
  bool _focused = false;

  void _setPressed(bool value) {
    if (value != _pressed) setState(() => _pressed = value);
  }

  @override
  Widget build(BuildContext context) {
    final colors = _Palette.of(context);
    // The button presses into its offset, and stays down while it is disabled.
    final sunk = _pressed || widget.onPressed == null;
    final showFocus =
        _focused &&
        FocusManager.instance.highlightMode == FocusHighlightMode.traditional;
    return Padding(
      padding: const EdgeInsets.only(bottom: _offset),
      child: Listener(
        onPointerDown: (_) => _setPressed(true),
        onPointerUp: (_) => _setPressed(false),
        onPointerCancel: (_) => _setPressed(false),
        child: AnimatedContainer(
          duration: MediaQuery.disableAnimationsOf(context)
              ? Duration.zero
              : const Duration(milliseconds: 100),
          curve: Curves.easeOut,
          transform: Matrix4.translationValues(0, sunk ? _offset : 0, 0),
          decoration: ShapeDecoration(
            shape: const StadiumBorder(),
            shadows: [
              if (!sunk)
                BoxShadow(
                  color: colors.dyeDeep,
                  offset: const Offset(0, _offset),
                ),
            ],
          ),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              FilledButton(
                onPressed: widget.onPressed,
                onFocusChange: (value) => setState(() => _focused = value),
                style: FilledButton.styleFrom(
                  backgroundColor: colors.dye,
                  foregroundColor: colors.onDye,
                  disabledBackgroundColor: colors.wash,
                  disabledForegroundColor: colors.pineSoft,
                  minimumSize: const Size(184, 56),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 32,
                    vertical: 16,
                  ),
                  shape: const StadiumBorder(),
                  textStyle: const TextStyle(
                    fontFamily: 'Atkinson Hyperlegible',
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                child: Text(widget.label, textAlign: TextAlign.center),
              ),
              if (showFocus)
                Positioned.fill(
                  left: -5,
                  top: -5,
                  right: -5,
                  bottom: -5,
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: ShapeDecoration(
                        shape: StadiumBorder(
                          side: BorderSide(color: colors.dye, width: 3),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TestIllustration extends StatefulWidget {
  const _TestIllustration({required this.active, required this.lines});

  final bool active;
  final int lines;

  @override
  State<_TestIllustration> createState() => _TestIllustrationState();
}

class _TestIllustrationState extends State<_TestIllustration>
    with SingleTickerProviderStateMixin {
  late final _animation = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 3),
  );

  void _syncAnimation() {
    if (widget.active && !MediaQuery.disableAnimationsOf(context)) {
      if (!_animation.isAnimating) _animation.repeat();
    } else {
      _animation.stop();
      _animation.value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncAnimation();
  }

  @override
  void didUpdateWidget(covariant _TestIllustration oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncAnimation();
  }

  @override
  void dispose() {
    _animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = _Palette.of(context);
    return ExcludeSemantics(
      child: SizedBox(
        height: 200,
        // The dye develops: each result line fades in after the one before it.
        child: TweenAnimationBuilder<double>(
          tween: Tween(end: widget.lines.toDouble()),
          duration: MediaQuery.disableAnimationsOf(context)
              ? Duration.zero
              : const Duration(milliseconds: 600),
          builder: (context, developed, _) => AnimatedBuilder(
            animation: _animation,
            builder: (context, _) => CustomPaint(
              size: Size.infinite,
              painter: _StickPainter(
                colors: colors,
                progress: _animation.value,
                active: widget.active,
                developed: developed,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Draws the app icon's stick, using the same 108-unit grid.
class _StickPainter extends CustomPainter {
  const _StickPainter({
    required this.colors,
    required this.progress,
    required this.active,
    required this.developed,
  });

  static const _scale = 2.4;
  static const _gridCenter = 54.0;
  static const _tilt = 20 * pi / 180;
  static const _shadowDrop = 6.0;

  final _Palette colors;
  final double progress;
  final bool active;
  final double developed;

  RRect _rect(double x, double y, double width, double height, double radius) =>
      RRect.fromRectAndRadius(
        Rect.fromLTWH(
          (x - _gridCenter) * _scale,
          (y - _gridCenter) * _scale,
          width * _scale,
          height * _scale,
        ),
        Radius.circular(radius * _scale),
      );

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    canvas.drawCircle(center, 84, Paint()..color = colors.window);
    if (active) {
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: 96),
        progress * pi * 2,
        pi / 3,
        false,
        Paint()
          ..color = colors.dye
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..strokeCap = StrokeCap.round,
      );
    }

    final tilt = _tilt + sin(progress * pi * 2) * 0.025;
    final body = _rect(43.5, 23, 21, 62, 10.5);

    canvas
      ..save()
      ..translate(center.dx, center.dy + _shadowDrop)
      ..rotate(tilt)
      ..drawRRect(body, Paint()..color = colors.stickShadow)
      ..restore();

    final rib = Paint()..color = _Palette.stickRib;
    final cap = Paint()..color = _Palette.stickCap;
    canvas
      ..save()
      ..translate(center.dx, center.dy)
      ..rotate(tilt)
      ..drawRRect(body, Paint()..color = _Palette.stickBody)
      ..drawRRect(_rect(43.5, 67, 21, 18, 10.5), cap)
      ..drawRRect(_rect(43.5, 67, 21, 8, 0), cap)
      ..drawRRect(_rect(48.5, 72, 11, 2.3, 1.15), rib)
      ..drawRRect(_rect(48.5, 77, 11, 2.3, 1.15), rib)
      ..drawRRect(
        _rect(47, 33, 14, 27, 4.5),
        Paint()..color = _Palette.stickWindow,
      );
    for (final (index, y) in const [39.0, 49.0].indexed) {
      final opacity = (developed - index).clamp(0.0, 1.0);
      if (opacity == 0) continue;
      canvas.drawRRect(
        _rect(49.5, y, 9, 3.8, 1.9),
        Paint()..color = _Palette.stickLine.withValues(alpha: opacity),
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _StickPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.active != active ||
      oldDelegate.developed != developed ||
      oldDelegate.colors.dark != colors.dark;
}
