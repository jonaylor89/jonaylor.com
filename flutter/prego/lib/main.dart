import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
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
    return MaterialApp(
      title: 'Prego',
      theme: ThemeData(
        useMaterial3: false,
        primarySwatch: Colors.blue,
        brightness: _darkMode ? Brightness.dark : Brightness.light,
      ),
      home: MyHomePage(onChangeTheme: _changeTheme),
    );
  }
}

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.onChangeTheme});

  final VoidCallback onChangeTheme;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  final _stopwatch = Stopwatch();
  final _random = Random();
  Timer? _timer;
  bool _isThinking = false;

  @override
  void dispose() {
    _timer?.cancel();
    _stopwatch.stop();
    super.dispose();
  }

  void _startDataCollection() {
    setState(() => _stopwatch.start());
    _timer = Timer.periodic(const Duration(milliseconds: 100), (_) {
      setState(() {});
    });
  }

  Future<void> _stopDataCollection() async {
    _timer?.cancel();
    setState(() {
      _stopwatch.stop();
      _isThinking = true;
    });

    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => const PopScope(
          canPop: false,
          child: Dialog(
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.all(Radius.circular(10)),
            ),
            child: Padding(
              padding: EdgeInsets.all(16),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircularProgressIndicator(),
                  SizedBox(width: 20),
                  Text('Crunching Numbers'),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    // This is a novelty app: these results are random, not a medical test.
    final isPregnant = _random.nextInt(100) < 25;
    final numberOfChildren = isPregnant ? _random.nextInt(10) + 1 : 0;
    await Future<void>.delayed(const Duration(seconds: 3));
    if (!mounted) return;
    Navigator.of(context).pop();

    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text(
          'Results',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 30, fontWeight: FontWeight.bold),
        ),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(32)),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Pregnant: ',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            Text('$isPregnant'),
            const Text(
              'Number of children: ',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            Text('$numberOfChildren'),
            const Text(
              'Total time for data collection: ',
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            Text(_formatDuration(_stopwatch.elapsed)),
            const SizedBox(height: 12),
            const Text('Random results — for entertainment only.'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Ok'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    setState(() {
      _stopwatch.reset();
      _isThinking = false;
    });
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int value) => value.toString().padLeft(2, '0');
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    final centiseconds = twoDigits(
      duration.inMilliseconds.remainder(1000) ~/ 10,
    );
    return '$minutes:$seconds:$centiseconds';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Prego')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              _formatDuration(_stopwatch.elapsed),
              style: const TextStyle(fontSize: 50),
            ),
            ElevatedButton(
              onPressed: _isThinking
                  ? null
                  : () {
                      if (_stopwatch.isRunning) {
                        unawaited(_stopDataCollection());
                      } else {
                        _startDataCollection();
                      }
                    },
              style: ElevatedButton.styleFrom(
                foregroundColor: Colors.white,
                padding: EdgeInsets.zero,
                shape: const RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(15)),
                ),
              ),
              child: Container(
                decoration: const BoxDecoration(
                  borderRadius: BorderRadius.all(Radius.circular(15)),
                  gradient: LinearGradient(
                    colors: [Color(0xFF6699FF), Color(0xFFFF99FF)],
                  ),
                ),
                padding: const EdgeInsets.all(10),
                child: Text(
                  _stopwatch.isRunning ? 'Stop' : 'Start',
                  style: const TextStyle(fontSize: 40),
                ),
              ),
            ),
            const SizedBox(height: 16),
            const Text('For entertainment only — results are random.'),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: widget.onChangeTheme,
        tooltip: 'Change Theme',
        child: const Icon(Icons.add),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.endDocked,
    );
  }
}
