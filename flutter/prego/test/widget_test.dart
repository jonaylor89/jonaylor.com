import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:prego/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  late SharedPreferences preferences;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    preferences = await SharedPreferences.getInstance();
  });

  testWidgets('collection starts, stops, shows results and resets', (
    tester,
  ) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    expect(find.text('Prego'), findsOneWidget);
    expect(find.text('00:00:00'), findsOneWidget);
    expect(
      find.text('For entertainment only — results are random.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Start'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Stop'), findsOneWidget);

    await tester.tap(find.text('Stop'));
    await tester.pump();
    expect(find.text('Crunching Numbers'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('Results'), findsOneWidget);
    expect(find.text('Number of children: '), findsOneWidget);

    await tester.tap(find.text('Ok'));
    await tester.pumpAndSettle();
    expect(find.text('00:00:00'), findsOneWidget);
    expect(find.text('Start'), findsOneWidget);

    // A second collection must not retain the previous timer.
    await tester.tap(find.text('Start'));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Stop'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets('theme changes are persisted and restored', (tester) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    Brightness brightness() =>
        Theme.of(tester.element(find.byType(Scaffold))).brightness;
    expect(brightness(), Brightness.light);

    await tester.tap(find.byTooltip('Change Theme'));
    await tester.pumpAndSettle();
    expect(brightness(), Brightness.dark);
    expect(preferences.getBool('darkMode'), isTrue);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(MyApp(preferences: preferences));
    expect(brightness(), Brightness.dark);

    await tester.tap(find.byTooltip('Change Theme'));
    await tester.pumpAndSettle();
    expect(brightness(), Brightness.light);
    expect(preferences.getBool('darkMode'), isFalse);
  });

  testWidgets('disposing during loading does not update an unmounted widget', (
    tester,
  ) async {
    await tester.pumpWidget(MyApp(preferences: preferences));
    await tester.tap(find.text('Start'));
    await tester.pump();
    await tester.tap(find.text('Stop'));
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 4));
    expect(tester.takeException(), isNull);
  });
}
