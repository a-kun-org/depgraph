namespace Game.Telemetry.Infrastructure
{
    public class TelemetryHttpClient
    {
        // Intentional layer violation: infra depends on application
        private TelemetryRecorder _recorder;

        public void Flush()
        {
            _recorder.Record(new TelemetryEvent { Name = "flush" });
        }
    }
}
