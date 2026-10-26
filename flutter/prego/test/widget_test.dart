import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:prego/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  late SharedPreferences preferences;
  final action = find.byKey(const ValueKey('primary-action'));

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    preferences = await SharedPreferences.getInstance();
  });

  Future<void> tapAction(WidgetTester tester) async {
    await tester.ensureVisible(action);
    await tester.tap(action);
    await tester.pump();
  }

  testWidgets('start, suspense, reveal and reset form a repeatable flow', (
    tester,
  ) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    expect(find.text('00:00.00'), findsOneWidget);
    expect(find.text('Ready when you are.'), findsOneWidget);
    expect(find.byType(FilledButton), findsOneWidget);

    await tapAction(tester);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Reveal'), findsOneWidget);
    expect(find.text('Take your time.'), findsOneWidget);

    await tapAction(tester);
    expect(find.text('Thinking…'), findsOneWidget);
    expect(find.text('Very scientific.'), findsOneWidget);
    expect(tester.widget<FilledButton>(action).onPressed, isNull);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('Try again'), findsOneWidget);
    expect(find.textContaining(RegExp(r'^\d+ bab(y|ies)$')), findsOneWidget);

    // The result stays on screen until explicitly reset, useful for recording.
    await tester.pump(const Duration(seconds: 10));
    expect(find.text('Try again'), findsOneWidget);
    await tapAction(tester);
    await tester.pumpAndSettle();
    expect(find.text('00:00.00'), findsOneWidget);
    expect(find.text('Start'), findsOneWidget);

    await tapAction(tester);
    expect(find.text('Reveal'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'timer digits keep a fixed width with the bundled monospace font',
    (tester) async {
      final font = FontLoader('DM Mono')
        ..addFont(rootBundle.load('assets/fonts/DMMono-500.ttf'));
      await font.load();
      await tester.pumpWidget(MyApp(preferences: preferences));
      final timer = tester.widget<Text>(
        find.byKey(const ValueKey('elapsed-time')),
      );
      expect(timer.style!.fontFamily, 'DM Mono');

      double width(String value) {
        final painter = TextPainter(
          text: TextSpan(text: value, style: timer.style),
          textDirection: TextDirection.ltr,
        )..layout();
        final result = painter.width;
        painter.dispose();
        return result;
      }

      final initialWidth = width('00:00.00');
      for (final value in ['11:11.11', '23:45.67', '88:88.88', '59:59.99']) {
        expect(width(value), closeTo(initialWidth, 0.001));
      }
    },
  );

  for (final value in [0, 9, 99]) {
    final pregnant = value < 25;
    final babies = pregnant ? value % 10 + 1 : 0;
    testWidgets('random result with $babies babies', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: MyHomePage(onChangeTheme: () {}, random: _FixedRandom(value)),
        ),
      );
      await tapAction(tester);
      await tapAction(tester);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(
        find.text(pregnant ? 'Pregnant.' : 'Not pregnant.'),
        findsOneWidget,
      );
      expect(
        find.text('$babies ${babies == 1 ? 'baby' : 'babies'}'),
        findsOneWidget,
      );
    });
  }

  testWidgets('controls have accessible labels and touch targets', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
      await tester.pumpWidget(MyApp(preferences: preferences));
      await tester.pumpAndSettle();
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    } finally {
      semantics.dispose();
    }
  });

  testWidgets('theme changes are persisted and restored', (tester) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    Brightness brightness() =>
        Theme.of(tester.element(find.byType(Scaffold))).brightness;
    expect(brightness(), Brightness.light);

    await tester.tap(find.byTooltip('Switch to dark mode'));
    await tester.pumpAndSettle();
    expect(brightness(), Brightness.dark);
    expect(preferences.getBool('darkMode'), isTrue);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(MyApp(preferences: preferences));
    expect(brightness(), Brightness.dark);

    await tester.tap(find.byTooltip('Switch to light mode'));
    await tester.pumpAndSettle();
    expect(brightness(), Brightness.light);
    expect(preferences.getBool('darkMode'), isFalse);
  });

  testWidgets('disposing during suspense cancels the pending reveal', (
    tester,
  ) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    await tapAction(tester);
    await tapAction(tester);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 4));
    expect(tester.takeException(), isNull);
  });

  testWidgets('wordmark opens licenses without extra screen chrome', (
    tester,
  ) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    await tester.tap(find.byTooltip('Open-source licenses'));
    await tester.pumpAndSettle();
    expect(find.text('Licenses'), findsOneWidget);
    expect(find.text('Prego'), findsOneWidget);
  });

  for (final size in [const Size(320, 568), const Size(844, 390)]) {
    testWidgets('flow fits $size with large text and reduced motion', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(
              size: size,
              textScaler: TextScaler.linear(1.8),
              disableAnimations: true,
            ),
            child: MyHomePage(onChangeTheme: () {}),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      await tapAction(tester);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tapAction(tester);
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tapAction(tester);
      await tester.pumpAndSettle();
      expect(find.text('00:00.00'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}

class _FixedRandom implements Random {
  _FixedRandom(this.value);

  final int value;

  @override
  int nextInt(int max) => value % max;

  @override
  bool nextBool() => value.isEven;

  @override
  double nextDouble() => 0.5;
}
