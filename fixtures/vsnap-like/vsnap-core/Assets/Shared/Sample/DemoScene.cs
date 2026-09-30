namespace Vsnap.Sample
{
    public class DemoScene
    {
        private SessionRunner _runner;

        // ツール層 → アプリ層は中立だが依存は表示する
        public void Play(SessionRunner runner)
        {
            _runner = runner;
        }
    }
}
