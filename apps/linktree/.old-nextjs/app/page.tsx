import Header from "@/components/Header";
import Footer from "@/components/Footer";
import Card from "@/components/Card";
import { type Item, items } from "@/components/assets/items";


export default function Home() {
  return (

          <div className = "App" >
            <Header />
            <div className = "container row">
                {
                    items.map((item: Item, i: number) => {
                        return(
                          <Card
                              key={i}
                              i={i}
                              {...item}
                            />  
                        )
                    })
                }
            </div>
            <Footer />
        </div>
  );
}

