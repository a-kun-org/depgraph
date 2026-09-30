import '../storage/session_store.dart';
import '../widgets/unity_commands.dart';

String describe(SessionStore store, UnityCommands cmds) => '${store.token}:${cmds}';
