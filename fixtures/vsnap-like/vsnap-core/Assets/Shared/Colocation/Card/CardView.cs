namespace Vsnap.Colocation.Card
{
    public class CardView
    {
        private ColocationSession _session;

        public void Bind(ColocationSession session)
        {
            _session = session;
        }
    }
}
