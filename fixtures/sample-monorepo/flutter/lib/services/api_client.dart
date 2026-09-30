import 'session_store.dart';

class ApiClient {
  ApiClient(this.store);

  final SessionStore store;

  Future<String> fetch() async => 'ok';
}
