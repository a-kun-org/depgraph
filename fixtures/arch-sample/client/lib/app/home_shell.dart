import '../storage/session_store.dart';
import '../config/app_config.dart';

class HomeShell {
  HomeShell(this.store, this.config);
  final SessionStore store;
  final AppConfig config;
}
