import 'package:flutter/material.dart';
import 'package:sample_app/services/api_client.dart';

class HomePage extends StatelessWidget {
  HomePage({super.key, required this.client});

  final ApiClient client;

  @override
  Widget build(BuildContext context) {
    return const Text('home');
  }
}
