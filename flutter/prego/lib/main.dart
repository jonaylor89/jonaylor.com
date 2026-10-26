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
    for (final font in ['DMSans', 'Fraunces']) {
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
        scaffoldBackgroundColor: colors.background,
        fontFamily: 'DM Sans',
        colorScheme: ColorScheme.fromSeed(
          seedColor: colors.accent,
          brightness: _darkMode ? Brightness.dark : Brightness.light,
          surface: colors.surface,
          primary: colors.accent,
          onSurface: colors.ink,
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
  Color get background => Color(dark ? 0xFF1B211E : 0xFFF4F1E7);
  Color get surface => Color(dark ? 0xFF262F29 : 0xFFFFFDF6);
  Color get ink => Color(dark ? 0xFFF7F3E8 : 0xFF282D26);
  Color get muted => Color(dark ? 0xFFB5BCAF : 0xFF686D61);
  Color get accent => Color(dark ? 0xFFF68C74 : 0xFFBA402F);
  Color get onAccent => Color(dark ? 0xFF241D19 : 0xFFFFFDF6);
  Color get blush => Color(dark ? 0xFF473A32 : 0xFFF5E2D6);
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
                systemNavigationBarColor: colors.background,
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
                            style: TextStyle(color: colors.accent),
                          ),
                        ],
                      ),
                      textScaler: TextScaler.noScaling,
                      style: _display(colors, 32),
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
            colors.dark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
            size: 20,
            color: colors.muted,
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
          symbol: result ? (_isPregnant ? '+' : '−') : '?',
        ),
        const SizedBox(height: 28),
        if (result)
          Semantics(
            liveRegion: true,
            child: Text(
              _isPregnant ? 'Pregnant.' : 'Not pregnant.',
              textAlign: TextAlign.center,
              style: _display(colors, 40),
            ),
          )
        else
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
                  color: colors.ink,
                  fontSize: 52,
                  fontWeight: FontWeight.w500,
                  letterSpacing: -2,
                  height: 1.1,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
          ),
        const SizedBox(height: 10),
        Semantics(
          liveRegion: true,
          child: Text(
            status,
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.muted, fontSize: 14, height: 1.5),
          ),
        ),
        const SizedBox(height: 32),
        Align(
          child: FilledButton(
            key: const ValueKey('primary-action'),
            onPressed: switch (_phase) {
              _Phase.ready => _start,
              _Phase.collecting => _reveal,
              _Phase.thinking => null,
              _Phase.result => _reset,
            },
            style: FilledButton.styleFrom(
              backgroundColor: colors.accent,
              foregroundColor: colors.onAccent,
              disabledBackgroundColor: colors.blush,
              disabledForegroundColor: colors.muted,
              minimumSize: const Size(184, 56),
              padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
              shape: const StadiumBorder(),
              textStyle: const TextStyle(
                fontFamily: 'DM Sans',
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
            child: Text(switch (_phase) {
              _Phase.ready => 'Start',
              _Phase.collecting => 'Reveal',
              _Phase.thinking => 'Thinking…',
              _Phase.result => 'Try again',
            }, textAlign: TextAlign.center),
          ),
        ),
      ],
    );
  }
}

TextStyle _display(_Palette colors, double size) => TextStyle(
  fontFamily: 'Fraunces',
  fontSize: size,
  fontWeight: FontWeight.w600,
  height: 1.12,
  letterSpacing: -1.3,
  color: colors.ink,
);

class _TestIllustration extends StatefulWidget {
  const _TestIllustration({required this.active, required this.symbol});

  final bool active;
  final String symbol;

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
    // This is a decorative drawing, including its tiny printed wordmark.
    return MediaQuery.withNoTextScaling(
      child: ExcludeSemantics(
        child: SizedBox(
          height: 200,
          child: AnimatedBuilder(
            animation: _animation,
            builder: (context, child) => CustomPaint(
              painter: _OrbitPainter(
                colors: colors,
                progress: _animation.value,
                active: widget.active,
              ),
              child: Center(
                child: Transform.rotate(
                  angle: -0.18 + sin(_animation.value * pi * 2) * 0.025,
                  child: child,
                ),
              ),
            ),
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: SizedBox(
                width: 234,
                height: 60,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFFDF6),
                    borderRadius: BorderRadius.circular(30),
                    border: Border.all(color: const Color(0xFFD5D7CB)),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.09),
                        offset: const Offset(0, 8),
                        blurRadius: 0,
                      ),
                    ],
                  ),
                  child: Row(
                    children: [
                      const SizedBox(width: 25),
                      Container(
                        width: 65,
                        height: 31,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: const Color(0xFFE7EBDF),
                          border: Border.all(color: const Color(0xFFC8CEBD)),
                          borderRadius: BorderRadius.circular(7),
                        ),
                        child: Text(
                          widget.symbol,
                          style: const TextStyle(
                            fontSize: 23,
                            height: 1,
                            fontWeight: FontWeight.w600,
                            color: Color(0xFF555F4C),
                          ),
                        ),
                      ),
                      const Spacer(),
                      const Text(
                        'prego.',
                        style: TextStyle(
                          fontFamily: 'Fraunces',
                          fontSize: 12,
                          color: Color(0xFF686D61),
                        ),
                      ),
                      const SizedBox(width: 13),
                      Container(
                        width: 56,
                        decoration: const BoxDecoration(
                          color: Color(0xFFDF765F),
                          borderRadius: BorderRadius.horizontal(
                            right: Radius.circular(29),
                          ),
                        ),
                        child: Center(
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: List.generate(
                              3,
                              (_) => Container(
                                width: 2,
                                height: 23,
                                margin: const EdgeInsets.symmetric(
                                  horizontal: 3,
                                ),
                                color: const Color(0xFFC75F4B),
                              ),
                            ),
                          ),
                        ),
                      ),
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
}

class _OrbitPainter extends CustomPainter {
  const _OrbitPainter({
    required this.colors,
    required this.progress,
    required this.active,
  });

  final _Palette colors;
  final double progress;
  final bool active;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    canvas.drawCircle(center, 84, Paint()..color = colors.blush);
    if (active) {
      final paint = Paint()
        ..color = colors.accent
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round;
      canvas.drawArc(
        Rect.fromCircle(center: center, radius: 96),
        progress * pi * 2,
        pi / 3,
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _OrbitPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.active != active ||
      oldDelegate.colors.dark != colors.dark;
}
